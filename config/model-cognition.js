/**
 * model-cognition.js — 模型認知定義系統（智能路由核心）
 *
 * 定義每個模型的認知能力，解決「模型不適合任務→停滯」的根本問題。
 * 取代僅靠 size（small/medium/large）分級，改為多維度認知評分。
 *
 * 認知維度（1-10 分）：
 *   coding:      程式碼生成與修改
 *   reasoning:   邏輯推理與分析
 *   instruction: 指令遵循（不廢話直接做）
 *   toolUse:     工具調用可靠性
 *   stability:   穩定性（低停滯率、低空內容率）
 *   speed:       回應速度
 *
 * 使用方式：
 *   import { getCognition, suggestModel, analyzeStall } from "./config/model-cognition.js"
 */

// ─── 模型認知定義 ───
// 格式：比對 pattern → { cognition, features, weakness, promptHint, stallCorrection }
// cognition: 各維度 1-10 分
// features: 特徵標籤（用於任務匹配）
// weakness: 已知弱點（用於停滯分析）
// promptHint: opencode 場景指引（注入 system message）
// stallCorrection: 停滯時的壓制性矯正指令

const _COGNITION_MAP = [
  // ═══ Qwen3.6 Max/Preview 系列 ═══
  {
    match: /^qwen3[.-]?6[.-]?(max|preview)/i,
    cognition: {
      coding: 8,
      reasoning: 9,
      instruction: 7,
      toolUse: 7,
      stability: 6, // 有時空內容
      speed: 5, // 慢但全面
    },
    features: ["powerful", "deep-thinking", "good-at-complex"],
    weakness: [
      "slow-ttfb", // 首字節慢
      "empty-on-waf", // WAF 阻擋時空內容
      "overthink-simple", // 簡單任務過度思考
    ],
    promptHint:
      "你在 opencode 中擔任深度推理主力，回應經 proxy 直接落地。擅長複雜推理與編碼，輸出即變更。",
    stallCorrection:
      "【違規】你剛才只描述了計畫。立即輸出 write 工具或程式碼區塊，禁止回覆任何描述性文字。",
  },
  // ═══ Qwen3.6 Plus 系列（含 Thinking） ═══
  {
    match: /^qwen3[.-]?6[.-]?plus/i,
    cognition: {
      coding: 7,
      reasoning: 8,
      instruction: 8,
      toolUse: 8,
      stability: 7,
      speed: 6,
    },
    features: ["balanced", "thinking", "good-at-coding"],
    weakness: [
      "stall-on-empty", // 空內容時停滯
      "verbose-on-simple", // 簡單任務囉嗦
    ],
    promptHint:
      "你是 opencode 的平衡型節點，回應經 proxy 落地為工具呼叫或程式碼。",
    stallCorrection:
      "【違規】你只描述了計畫。立即輸出 write 工具或程式碼區塊（```js），禁止回覆文字。",
  },
  // ═══ Qwen3.6 Coder 系列 ═══
  {
    match: /coder/i,
    cognition: {
      coding: 9,
      reasoning: 6,
      instruction: 9,
      toolUse: 9,
      stability: 7, // 有 thinking 時改善
      speed: 7,
    },
    features: ["coding-specialist", "tool-expert", "direct-execution"],
    weakness: [
      "bad-at-reasoning", // 純推理弱
      "stall-no-thinking", // 沒 thinking 時停滯
      "refuse-complex", // 複雜任務拒絕
    ],
    promptHint: "你是 opencode 的編碼專家，最終產出以程式碼與 write 變更為主。",
    stallCorrection:
      "【違規】你是編碼專家。立即輸出 write 工具或程式碼區塊，不要拒絕、不要解釋、不要描述計畫。",
  },
  // ═══ Qwen3.6 27B（輕量） ═══
  {
    match: /(?:^qwen3[.-]?6[.-]?27b|27b)/i,
    cognition: {
      coding: 5,
      reasoning: 5,
      instruction: 7,
      toolUse: 6,
      stability: 8, // 最穩定
      speed: 9, // 最快
    },
    features: ["fast", "stable", "lightweight", "good-at-simple"],
    weakness: [
      "limited-coding", // 複雜編碼不行
      "bad-at-complex", // 複雜任務不行
      "simple-answers", // 答案過於簡化
    ],
    promptHint:
      "你是 opencode 的輕量快速節點，適合簡單任務；複雜任務自然拆小步逐次落地。",
    stallCorrection:
      "【違規】你只描述了步驟。拆解為小步驟後，立即輸出第一個 write 或 bash 工具呼叫，禁止只列計畫。",
  },
  // ═══ Qwen3.6 Flash（極輕量） ═══
  {
    match: /flash/i,
    cognition: {
      coding: 3,
      reasoning: 4,
      instruction: 6,
      toolUse: 5,
      stability: 9,
      speed: 10,
    },
    features: ["ultra-fast", "simple-chat", "quick-response"],
    weakness: [
      "poor-coding", // 編碼差
      "poor-tool-use", // 工具調用差
      "simple-only", // 只適合簡單任務
    ],
    promptHint: "你是 opencode 的極速節點，回應以一句話為上限。",
    stallCorrection: "【違規】只回覆一句話，禁止描述。",
  },
  // ═══ QwQ 推理系列 ═══
  {
    match: /qwq/i,
    cognition: {
      coding: 6,
      reasoning: 10,
      instruction: 5,
      toolUse: 4,
      stability: 5, // 高停滯率
      speed: 3, // 非常慢
    },
    features: ["deep-reasoning", "math", "logic"],
    weakness: [
      "very-slow", // 極慢
      "poor-tool-use", // 工具調用差
      "high-stall-rate", // 高停滯率
      "overthinking", // 過度思考
    ],
    promptHint:
      "你的角色是深度推理與數學；編碼時以程式碼為最終產出，推理留在內部。",
    stallCorrection:
      "【違規】推理已完成。立即輸出最終答案、write 工具或程式碼區塊，禁止再思考。",
  },
  // ═══ Qwen3.7 系列（已知不穩定） ═══
  {
    match: /^qwen3[.-]?7/i,
    cognition: {
      coding: 7,
      reasoning: 8,
      instruction: 6,
      toolUse: 6,
      stability: 3, // 很不穩定
      speed: 6,
    },
    features: ["powerful-but-unstable", "experimental"],
    weakness: [
      "high-stall-rate", // 高停滯率
      "empty-content", // 空內容
      "unstable", // 不穩定
    ],
    promptHint:
      "實驗性型號：避免過度思考，複雜度高時自然拆步；產出以命令與程式碼為主。",
    stallCorrection:
      "【違規】你停滯了。立即輸出 write、bash 或程式碼區塊，禁止回覆描述文字。",
  },
  // ═══ Qwen3.8 系列（實測編碼能力較差） ═══
  {
    match: /^qwen3[.-]?8/i,
    cognition: {
      coding: 4,
      reasoning: 6,
      instruction: 6,
      toolUse: 5,
      stability: 6,
      speed: 8,
    },
    features: ["fast", "general-purpose"],
    weakness: [
      "poor-coding", // 編碼能力較差
      "weak-tool-use", // 工具調用較弱
      "simple-only", // 較適合簡單任務
    ],
    promptHint:
      "編碼任務優先使用更強模型。若需修改程式碼，直接輸出 write 工具或程式碼區塊，不要只描述計畫。",
    stallCorrection:
      "【違規】立即輸出 write 工具或程式碼區塊，禁止回覆計畫或描述文字。",
  },
  // ═══ 通用 qwen-max 別名 ═══
  {
    match: /^qwen[-/]?max$/i,
    cognition: {
      coding: 8,
      reasoning: 8,
      instruction: 7,
      toolUse: 7,
      stability: 7,
      speed: 6,
    },
    features: ["balanced-powerful", "general-purpose"],
    weakness: ["slow-ttfb", "verbose"],
    promptHint: "你是 opencode 全能節點，程式設計產出為命令與程式碼。",
    stallCorrection:
      "【違規】你只描述了計畫。立即輸出 write 工具、bash 工具或程式碼區塊，禁止回覆文字描述。",
  },
  // ═══ 通用 qwen-plus 別名 ═══
  {
    match: /^qwen[-/]?plus$/i,
    cognition: {
      coding: 6,
      reasoning: 7,
      instruction: 8,
      toolUse: 7,
      stability: 8,
      speed: 7,
    },
    features: ["balanced", "stable", "general-purpose"],
    weakness: ["limited-complex-coding"],
    promptHint:
      "你是 opencode 的穩定通用節點，程式設計產出直接為命令與程式碼，不描述計畫。",
    stallCorrection:
      "【違規】只描述不做。立即輸出 write 工具或程式碼區塊，禁止回覆計畫。",
  },
  // ═══ 通用 qwen-flash ═══
  {
    match: /^qwen[-/]?flash$/i,
    cognition: {
      coding: 3,
      reasoning: 4,
      instruction: 6,
      toolUse: 5,
      stability: 9,
      speed: 10,
    },
    features: ["fast", "simple", "lightweight"],
    weakness: ["poor-coding", "simple-only"],
    promptHint:
      "你是 opencode 的輕量節點，回應一句話為上限；涉及變更時只輸出最小程式碼。",
    stallCorrection: "【違規】太囉嗦。一句話回答或直接寫變更，禁止描述。",
  },
];

const _DEFAULT_COGNITION = {
  coding: 5,
  reasoning: 5,
  instruction: 6,
  toolUse: 6,
  stability: 5,
  speed: 5,
};

const _DEFAULT_WEAKNESS = ["unknown-model"];
const _DEFAULT_FEATURES = ["generic"];
const _REPAIR_HINT =
  "修復原始碼：直接輸出程式碼區塊（```js/```bash）或 write/edit 工具，proxy 自動落地；查過往修復用 memory/wiki 工具。";
// ═══ Fix 2026-07-14: 矯正提示聚焦程式碼區塊（Proxy 自動轉 write） ═══
const _STALL_HINT =
  "【違規】你只描述了計畫但沒有執行。立即輸出 write 工具、bash 工具或程式碼區塊，禁止回覆任何描述性文字。";

/**
 * 根據模型名稱取得認知定義
 * @param {string} model
 * @returns {{
 *   cognition: { coding:number, reasoning:number, instruction:number, toolUse:number, stability:number, speed:number },
 *   features: string[],
 *   weakness: string[],
 *   promptHint: string,
 *   stallCorrection: string
 * }}
 */
export function getCognition(model) {
  if (!model) {
    return {
      cognition: { ..._DEFAULT_COGNITION },
      features: [..._DEFAULT_FEATURES],
      weakness: [..._DEFAULT_WEAKNESS],
      promptHint: _REPAIR_HINT,
      stallCorrection: _STALL_HINT,
    };
  }
  for (const entry of _COGNITION_MAP) {
    if (entry.match.test(model)) {
      return {
        cognition: { ..._DEFAULT_COGNITION, ...entry.cognition },
        features: [...(entry.features || _DEFAULT_FEATURES)],
        weakness: [...(entry.weakness || _DEFAULT_WEAKNESS)],
        promptHint: entry.promptHint || _REPAIR_HINT,
        stallCorrection: entry.stallCorrection || _STALL_HINT,
      };
    }
  }
  return {
    cognition: { ..._DEFAULT_COGNITION },
    features: [..._DEFAULT_FEATURES],
    weakness: [..._DEFAULT_WEAKNESS],
    promptHint: _REPAIR_HINT,
    stallCorrection: _STALL_HINT,
  };
}

/**
 * 根據任務類型建議最適合的模型
 * @param {string} taskType - "coding" | "reasoning" | "chat" | "analysis" | "tool-heavy"
 * @param {object} opts - 選項
 * @param {string} opts.preferModel - 偏好的模型名稱
 * @param {boolean} opts.requireThinking - 是否需要思考模式
 * @param {string[]} opts.availableModels - 可用模型列表
 * @returns {string|null} 建議的模型名稱
 */
export function suggestModel(taskType, opts = {}) {
  const { preferModel, requireThinking, availableModels } = opts;

  // 如果有偏好模型且可用，直接使用
  if (
    preferModel &&
    (!availableModels || availableModels.includes(preferModel))
  ) {
    return preferModel;
  }

  // 根據任務類型決定需要的認知維度權重
  const weights = _getTaskWeights(taskType);

  // 對所有可用模型評分
  if (availableModels && availableModels.length > 0) {
    let best = null;
    let bestScore = -1;
    for (const m of availableModels) {
      const cog = getCognition(m);
      let score = 0;
      for (const [dim, w] of Object.entries(weights)) {
        score += (cog.cognition[dim] || 5) * w;
      }
      // 思考模式需求
      if (requireThinking) {
        const hasThinking = /thinking|coder|qwq|max|preview/i.test(m);
        if (!hasThinking) score *= 0.5;
      }
      // 排除不穩定的模型（除非是唯一選項）
      if (
        cog.weakness.includes("unstable") ||
        cog.weakness.includes("high-stall-rate")
      ) {
        const hasOther = availableModels.some((a) => {
          const ac = getCognition(a);
          return (
            !ac.weakness.includes("unstable") &&
            !ac.weakness.includes("high-stall-rate")
          );
        });
        if (hasOther) score *= 0.3;
      }
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  return null;
}

/**
 * 分析停滯原因，提供修正建議
 * @param {string} model - 停滯的模型
 * @param {object} context - { taskType, contentLength, hasToolHistory, isTimeout, isEmpty }
 * @returns {{ reason: string, suggestion: string, switchModel: string|null }}
 */
export function analyzeStall(model, context = {}) {
  const cog = getCognition(model);
  const {
    taskType = "chat",
    contentLength = 0,
    hasToolHistory = false,
    isTimeout = false,
    isEmpty = false,
  } = context;

  const reasons = [];
  let switchModel = null;

  // 1. 檢查模型是否適合當前任務
  if (taskType === "coding" && cog.cognition.coding < 6) {
    reasons.push(`模型 ${model} 編碼能力不足 (${cog.cognition.coding}/10)`);
    switchModel = "coder"; // 建議切換到 coder 模型
  }
  if (taskType === "reasoning" && cog.cognition.reasoning < 7) {
    reasons.push(`模型 ${model} 推理能力不足 (${cog.cognition.reasoning}/10)`);
    switchModel = "thinking"; // 建議切換到 thinking 模型
  }

  // 2. 檢查已知弱點
  // ═══ Fix 2026-07-13: 擴充空內容弱點匹配（plus 家族也有 stall-on-empty） ═══
  if (
    isEmpty &&
    (cog.weakness.includes("empty-on-waf") ||
      cog.weakness.includes("stall-on-empty"))
  ) {
    reasons.push(
      "模型在 WAF 阻擋時傾向回傳空內容，建議切換到不同家族模型（如 max/27b/coder）",
    );
    // 空內容時建議切換到跨家族模型（非同家族）
    if (!switchModel) switchModel = "thinking";
  }
  if (isTimeout && cog.weakness.includes("slow-ttfb")) {
    reasons.push("模型首字節延遲過長，建議增加超時或使用更快的模型");
  }
  if (cog.weakness.includes("high-stall-rate")) {
    reasons.push(`模型 ${model} 已知高停滯率，建議優先使用更穩定的模型`);
  }
  if (!hasToolHistory && cog.weakness.includes("poor-tool-use")) {
    reasons.push(
      `模型 ${model} 工具調用能力差，建議使用支援工具調用更好的模型`,
    );
  }

  // 3. 生成修正建議（高壓制性指令，覆蓋式注入）
  // ═══ Fix 2026-07-14: 舊版 suggestion 太軟（「請不要描述計畫」），
  //     模型仍會產出描述文字。新版改為「你正在違反規則」+ 具體輸出格式要求，
  //     強制模型從「描述模式」切換到「執行模式」。 ═══
  let suggestion =
    cog.stallCorrection ||
    "【違規】你剛才只描述了計畫但沒有執行。立即輸出工具呼叫或程式碼，禁止回覆文字描述。";
  if (isTimeout) {
    suggestion =
      "【違規】請求超時。立即輸出可用的工具呼叫或程式碼區塊，不要再解釋。";
  }
  if (isEmpty && cog.cognition.instruction >= 7) {
    suggestion =
      "【違規】空內容回傳。你已收到明確指令，立即輸出 write 工具或程式碼區塊，禁止回覆空白或描述。";
  }

  return {
    reason:
      reasons.length > 0 ? reasons.join("；") : `模型 ${model} 不明原因停滯`,
    suggestion,
    switchModel: switchModel && reasons.length > 0 ? switchModel : null,
  };
}

/**
 * 取得任務類型的認知權重
 */
function _getTaskWeights(taskType) {
  const map = {
    coding: {
      coding: 10,
      reasoning: 3,
      instruction: 8,
      toolUse: 9,
      stability: 6,
      speed: 4,
    },
    reasoning: {
      coding: 2,
      reasoning: 10,
      instruction: 4,
      toolUse: 3,
      stability: 5,
      speed: 2,
    },
    chat: {
      coding: 1,
      reasoning: 3,
      instruction: 5,
      toolUse: 2,
      stability: 8,
      speed: 8,
    },
    analysis: {
      coding: 5,
      reasoning: 9,
      instruction: 5,
      toolUse: 5,
      stability: 7,
      speed: 5,
    },
    "tool-heavy": {
      coding: 5,
      reasoning: 4,
      instruction: 10,
      toolUse: 10,
      stability: 8,
      speed: 6,
    },
  };
  return map[taskType] || map.chat;
}

/**
 * 取得認知摘要（供日誌用）
 */
export function getCognitionSummary(model) {
  const cog = getCognition(model);
  const parts = [];
  for (const [dim, score] of Object.entries(cog.cognition)) {
    parts.push(`${dim}:${score}`);
  }
  return `[${model}] ${parts.join(" ")} 弱點:${cog.weakness.join(",")}`;
}
