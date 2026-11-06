/**
 * chinese.js — 中文格式處理（簡→繁轉換 + 思考段剝離）
 *
 * 解決兩個實測問題：
 *  1. 千問免額 Web API 回應含大量簡體字（實測「用户要求说三个数字」）
 *     → 統一轉繁體，符合用戶語言規範。
 *  2. 免額路線上游不吐 reasoning_content / phase（實測 grep 計數 = 0）
 *     → 思考過程與最終回答混在同一段 content，導致回覆膨脹、
 *       opencode 對話框塞滿思考文字。
 *     → 用啟發式偵測思考前綴並切出為 reasoning。
 *
 * 設計原則：
 *  - 轉換只作用於「回應輸出」，不動 system prompt / 工具參數（避免破壞程式碼）
 *  - 程式碼區塊（```）內不做轉換，中文註解也保留原樣 → 避免破壞可執行輸出
 *  - 轉換失敗一律靜默 fallback 原字串（不得讓轉換問題中斷主流程）
 */

import { Converter } from "opencc-js";

let _conv = null;

/** 取得（或延遲建立）簡→繁轉換器；失敗回 null */
const _getConv = () => {
  if (_conv !== null) return _conv || null;
  try {
    _conv = Converter({ from: "cn", to: "tw" });
  } catch (_) {
    _conv = false;
  }
  return _conv || null;
};

/** 是否含中文（無中文則跳過轉換，省 CPU） */
const _hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

/**
 * 簡→繁轉換（保留程式碼區塊原樣）
 * @param {string} text
 * @returns {string}
 */
export const toTrad = (text) => {
  if (!text || typeof text !== "string") return text;
  if (!_hasCJK(text)) return text;
  const conv = _getConv();
  if (!conv) return text;
  // 以 ```  fenced code block 為界，區塊內不轉換
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg) =>
      seg.startsWith("```") || seg.startsWith("`") ? seg : conv(seg),
    )
    .join("");
};

/**
 * 思考段偵測 — 上游免額路線思考混在 content，無 reasoning_content 欄位。
 *
 * 實測樣本（qwen3.6-plus-thinking）：
 *   "Here's a thinking process:\n\n1. **Understand User Request:** ...\n
 *    8. **Self-Correction/Verification:** ... Ready to output.✅以下提供兩種..."
 *
 * 實測樣本（qwen3.8-omni-flash）：
 *   "用戶要求：「...」。Python 快速排序實作…目前只需最終回覆。下面是一個使用 Python..."
 *
 * 答案起點標記（實測可靠）：
 *   - "Ready to output.✅"（英文模型）
 *   - "最終回覆 / 最終答案 / 最終輸出"（中文模型）
 *   - "✅" 單獨（需後方內容含 markdown 才採信）
 *
 * 保守策略：必須同時滿足才切
 *   1. 命中標記
 *   2. 標記後有實質答案（>= 8 字）
 *   3. 答案段含 markdown / 程式碼痕跡
 * 寧可多顯示，不可丟內容。
 */

// 答案起點標記（皆為「標記之後即為答案」）
const _ANSWER_MARKERS = [
  /Ready\s+to\s+output[.。!！]?\s*✅?\s*/i,
  /(?:最終回覆|最終答案|最終輸出|最終結論)\s*[:：]?\s*/,
  /(?:Here's|Here\s+is)\s+(?:the\s+)?(?:final\s+)?(?:answer|response)\s*[:：]?\s*/i,
];

/** 檢查候選答案段是否像真正的答案（含 markdown / 程式碼痕跡） */
const _looksLikeAnswer = (s) =>
  s.length >= 8 && /```|^\s*[#*>-]|\n\n/.test(s.slice(0, 400));

// 元敘述殘留（標記命中但後方仍是思考收尾，非真答案）
const _META_HEAD =
  /^\s*(?:Note\b|Proceeds?\b|Output\s+generation|Output\s+matches|The\s+system\s+prompt\b|I\s+(?:should|'ll|will)\b|Let\s+me\b|Self-Correction|Refinement|\*\(?(?:Self-Correction|Proceeds))/i;

export const splitThinking = (content) => {
  if (!content || typeof content !== "string")
    return { content: content || "", reasoning: "" };

  // 優先：明確的答案起點標記（取最後一個命中，避免誤切）
  let cut = -1;
  for (const re of _ANSWER_MARKERS) {
    const g = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : re.flags + "g",
    );
    let m;
    while ((m = g.exec(content)) !== null) {
      const end = m.index + m[0].length;
      if (end > cut && _looksLikeAnswer(content.slice(end))) cut = end;
    }
  }
  // 次選：單獨的 ✅（後方需含 markdown）
  if (cut < 0) {
    const gi = content.lastIndexOf("✅");
    if (gi >= 0 && _looksLikeAnswer(content.slice(gi + 1))) cut = gi + 1;
  }

  if (cut < 0) return { content, reasoning: "" };

  // ═══ 元敘述前進防護（2026-10-21 實測）═══
  // 標記（✅ / Ready to output）可能命中思考收尾內部，
  // 後方以 "Note: / Proceeds / Output generation" 等元敘述開頭 → 非真答案。
  // 此時前進到第一個「強答案訊號」（程式碼圍欄 / 標題 / 整行粗體），
  // 找不到則保守維持原切點（寧可多顯示，不可丟內容）。
  const after = content.slice(cut);
  const meta = after.match(_META_HEAD);
  if (meta) {
    const cands = [
      after.indexOf("```"),
      after.search(/\n\s*#{1,6}\s/),
      after.search(/\n\s*\*\*[^*\n]+\*\*/),
    ].filter((i) => i > meta[0].length && i < 600);
    if (cands.length) cut += Math.min(...cands);
  }

  const reasoning = content.slice(0, cut).trim();
  // 清除切點後殘留的元敘述碎片（如 "*(Proceeds)*"、"Output generation."）
  const rest = content
    .slice(cut)
    .trim()
    .replace(
      /^(?:\*{0,2}\(?(?:Proceeds?|Output\s+generation|Note|Ready)\)?\*{0,2}[:.。]?\s*)+/i,
      "",
    )
    .trim();
  if (reasoning.length < 8 || rest.length < 8)
    return { content, reasoning: "" };
  return { content: rest, reasoning };
};

/**
 * 綜合處理：剝離思考 + 轉繁體
 * @param {string} content
 * @param {object} opts
 * @param {boolean} opts.stripThinking 是否剝離思考段
 * @returns {{content: string, reasoning: string}}
 */
export const normalize = (content, opts = {}) => {
  const split =
    opts.stripThinking === false
      ? { content: content || "", reasoning: "" }
      : splitThinking(content);
  return {
    content: toTrad(split.content),
    reasoning: toTrad(split.reasoning),
  };
};

export default { toTrad, splitThinking, normalize };
