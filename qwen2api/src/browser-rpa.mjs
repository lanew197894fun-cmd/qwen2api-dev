/**
 * browser-rpa.mjs — UI 自動化（RPA）模組
 *
 * 透過 Puppeteer 操作真實 SPA UI，讓瀏覽器自然處理 WAF JS challenge。
 * 替代 page.evaluate(fetch) 模式（POST 被 WAF 阻擋），改為：
 *   - 點擊「新對話」按鈕 → SPA 觸發 POST → WAF 通過 → 取得 chat_id
 *   - 輸入訊息 + Enter → SPA 發送串流請求 → WAF 通過 → DOM 擷取回應
 *
 * 用法：
 *   import { createNewChat, sendMessage, discoverSelectors } from './browser-rpa.mjs';
 */

// ── 預設選擇器清單（會自動探索，可透過 discoverSelectors 更新） ──
let SELECTORS = {
  newChat: [
    'button:has-text("新对话")',
    'button:has-text("New Chat")',
    'button:has-text("新建对话")',
    '[class*="new"][class*="chat"]',
    'a[href*="/c/new"]',
    'button[class*="compose"]',
    'button[class*="create"]',
    'button[aria-label*="new" i]',
    'button[aria-label*="chat" i]',
    "button:has(svg)",
    'li[class*="new"] button',
    'div[class*="sidebar"] button:first-child',
  ],
  input: [
    "textarea.message-input-textarea",
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="输入" i]',
    'textarea[placeholder*="发送" i]',
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    '[class*="input"] textarea',
    '[class*="editor"] textarea',
    '[class*="chat-input"]',
    '[class*="message-input"]',
    ".ProseMirror",
    'textarea:not([style*="display:none"])',
  ],
  sendBtn: [
    'button[type="submit"]',
    'button:has-text("发送")',
    'button:has-text("Send")',
    "button:has(svg path)",
    '[class*="send"] button',
    'button[class*="send"]',
  ],
  messages: [
    '[class*="message"]:last-child [class*="assistant"]',
    '[class*="message"]:last-child',
    '[class*="conversation"] [class*="message"]:last-child',
    '[class*="chat"] [class*="message"]:last-child',
    'main [class*="content"]:last-child',
  ],
  assistantMsg: [
    ".qwen-chat-message-assistant .response-message-content",
    ".response-message-content.t2t.phase-answer",
    '[class*="message"][class*="assistant"]:last-child',
    '[class*="assistant"]:last-child [class*="content"]',
    '[class*="answer"]:last-child',
    '[class*="response"]:last-child',
  ],
  streaming: [
    ".qwen-chat-thinking-status-card-wraper:not(.qwen-chat-thinking-status-card-completed)",
    '[class*="streaming"]',
    '[class*="typing"]',
    '[class*="generating"]',
    ".loading-dots",
  ],
};

// ── Logger ──
function log(level, ...args) {
  const lv = { E: 1, W: 2, I: 3, D: 4 }[level] || 3;
  const ts = new Date().toISOString().slice(11, 23);
  const msg = `[${ts}] [${level}] [rpa] ${args.join(" ")}`;
  if (level === "E") console.error(msg);
  else if (level === "W") console.warn(msg);
  else console.log(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function now() {
  return Date.now();
}

// ── 選擇器探索 ──────────────────────────────────────────────────────
/**
 * 掃描頁面 DOM 結構，找出常見 UI 元素的選擇器
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<Object>} 包含發現的選擇器與頁面結構摘要
 */
export async function discoverSelectors(page) {
  log("I", "探索頁面 DOM 結構...");
  const result = await page.evaluate(() => {
    const info = {
      title: document.title,
      url: location.href,
      paths: {},
      buttons: [],
      inputs: [],
      textareas: [],
      editable: [],
      elementsWithContent: [],
      structure: "",
    };

    // 頁面結構摘要
    const walk = (el, depth = 0) => {
      if (depth > 4) return "";
      let s = "";
      const tag = el.tagName?.toLowerCase() || "";
      const cls = el.className
        ? typeof el.className === "string"
          ? el.className
          : el.className.baseVal || ""
        : "";
      const id = el.id || "";
      const txt = (el.textContent || "").trim().slice(0, 40);
      const aria = el.getAttribute("aria-label") || "";
      const role = el.getAttribute("role") || "";
      const placeholder = el.getAttribute("placeholder") || "";

      // 只輸出有意義的節點
      if (
        tag === "button" ||
        tag === "textarea" ||
        tag === "input" ||
        role === "textbox" ||
        aria ||
        placeholder ||
        (cls && cls.length > 3 && cls.length < 100)
      ) {
        const indent = "  ".repeat(depth);
        s += `${indent}<${tag}${id ? ` id="${id}"` : ""}${cls ? ` class="${cls.slice(0, 60)}"` : ""}${aria ? ` aria="${aria}"` : ""}${role ? ` role="${role}"` : ""}${placeholder ? ` ph="${placeholder}"` : ""}>${txt ? ` "${txt}"` : ""}\n`;
      }

      for (const child of el.children) {
        s += walk(child, depth + 1);
      }
      return s;
    };
    info.structure = walk(document.body);

    // 收集所有按鈕
    document
      .querySelectorAll("button, [role='button'], a[href]")
      .forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || "").trim().slice(0, 50);
        const cls = (el.className || "").slice(0, 40);
        const aria = el.getAttribute("aria-label") || "";
        const href = el.getAttribute("href") || "";
        if (text || aria) {
          info.buttons.push({ tag, text, cls, aria, href });
        }
      });

    // 收集輸入元素
    document
      .querySelectorAll(
        "textarea, input:not([type='hidden']):not([type='checkbox']):not([type='radio']), [contenteditable='true'], [role='textbox']",
      )
      .forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const placeholder = el.getAttribute("placeholder") || "";
        const cls = (el.className || "").slice(0, 40);
        const aria = el.getAttribute("aria-label") || "";
        const rect = el.getBoundingClientRect();
        info.inputs.push({
          tag,
          placeholder,
          cls,
          aria,
          visible: rect.width > 0 && rect.height > 0,
          rect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        });
      });

    return info;
  });

  log("I", `頁面標題: ${result.title}`);
  log("I", `URL: ${result.url}`);
  log(
    "I",
    `找到 ${result.buttons.length} 個按鈕, ${result.inputs.length} 個輸入元素`,
  );

  // 輸出按鈕
  for (const btn of result.buttons) {
    log(
      "D",
      `  按鈕: <${btn.tag}> text="${btn.text}" aria="${btn.aria}" cls="${btn.cls}"`,
    );
  }

  // 輸出輸入元素
  for (const inp of result.inputs) {
    log(
      "D",
      `  輸入: <${inp.tag}> ph="${inp.placeholder}" cls="${inp.cls}" visible=${inp.visible}`,
    );
  }

  log("D", `\n--- 頁面結構 ---\n${result.structure}`);

  // 嘗試找出最佳選擇器
  const discovered = { newChat: null, input: null, sendBtn: null };

  // 找新對話按鈕
  const ncKeywords = ["新对话", "new chat", "新建", "＋", "+", "新建对话"];
  for (const btn of result.buttons) {
    for (const kw of ncKeywords) {
      if (
        btn.text.toLowerCase().includes(kw.toLowerCase()) ||
        btn.aria.toLowerCase().includes(kw.toLowerCase())
      ) {
        discovered.newChat = {
          type: "text",
          text: btn.text,
          selector: `button:has-text("${btn.text}")`,
        };
        break;
      }
    }
    if (discovered.newChat) break;
  }

  // 找輸入框
  for (const inp of result.inputs) {
    if (inp.visible) {
      discovered.input = {
        tag: inp.tag,
        placeholder: inp.placeholder,
        selector:
          inp.tag === "textarea"
            ? `textarea[placeholder="${inp.placeholder}"]`
            : inp.tag === "input"
              ? `input[placeholder="${inp.placeholder}"]`
              : `[contenteditable="true"]`,
        isTextarea: inp.tag === "textarea",
      };
      break;
    }
  }

  log(
    "I",
    `最佳選擇器: newChat=${discovered.newChat?.selector || "?"}, input=${discovered.input?.selector || "?"}`,
  );

  return { discovered, raw: result };
}

// ── 透過 UI 建立新聊天 ──────────────────────────────────────────────
/**
 * 點擊「新對話」按鈕，讓 SPA 透過正常 POST 建立聊天
 * @param {import('puppeteer-core').Page} page
 * @param {Object} [opts]
 * @param {number} [opts.timeout=15000] 等待 chat_id 超時
 * @param {string[]} [opts.selectors] 自訂選擇器（覆蓋預設）
 * @returns {Promise<{chatId: string|null, url: string, method: string}>}
 */
export async function createNewChat(page, opts = {}) {
  const timeout = opts.timeout || 15000;
  const customSelectors = opts.selectors || SELECTORS.newChat;
  const deadline = now() + timeout;

  log("I", "建立新聊天 (UI)...");

  // 記錄當前 URL
  const initialUrl = page.url();

  // 嘗試點擊新對話按鈕
  let clicked = false;

  // 步驟 1: 用 page.evaluate 搜尋按鈕文字（可靠，支援 Puppeteer）
  // :has-text() 是 Playwright 專有語法，Puppeteer 的 querySelector 不支援
  try {
    const ncKeywords = ["新对话", "新建", "new chat", "＋", "+", "新建对话"];
    const btnInfo = await page.evaluate((keywords) => {
      const btns = document.querySelectorAll(
        'button, [role="button"], a[href]',
      );
      for (const btn of btns) {
        const text = (btn.textContent || "").trim();
        const aria = (btn.getAttribute("aria-label") || "").trim();
        for (const kw of keywords) {
          if (
            text.toLowerCase().includes(kw.toLowerCase()) ||
            aria.toLowerCase().includes(kw.toLowerCase())
          ) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { found: true, text: text.slice(0, 30), aria };
            }
          }
        }
      }
      return { found: false };
    }, ncKeywords);
    if (btnInfo.found) {
      // 已知按鈕文字，使用 XPath-like 選取（可點擊）
      const btns = await page.$$("button, [role='button'], a[href]");
      for (const btn of btns) {
        const text = await btn.evaluate((el) =>
          (el.textContent || "").trim().toLowerCase(),
        );
        const aria = await btn
          .evaluate((el) =>
            (el.getAttribute("aria-label") || "").trim().toLowerCase(),
          )
          .catch(() => "");
        for (const kw of ncKeywords) {
          if (text.includes(kw) || aria.includes(kw)) {
            const box = await btn.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              log(
                "D",
                `點擊 (文字匹配): "${btnInfo.text}" (${Math.round(box.width)}x${Math.round(box.height)})`,
              );
              await btn.click();
              clicked = true;
              break;
            }
          }
        }
        if (clicked) break;
      }
    }
  } catch (e) {
    log("D", `文字匹配點擊失敗: ${e.message}`);
  }

  // 步驟 2: CSS 選擇器掃描（僅支援標準 CSS，跳過 :has-text 等 Puppeteer 不支援的選擇器）
  if (!clicked) {
    for (const sel of customSelectors) {
      if (now() > deadline) break;
      // 跳過 Playwright-only 選擇器
      if (
        sel.includes(":has-text") ||
        (sel.includes(":has(") && !sel.includes("button:has(svg)"))
      ) {
        continue;
      }
      try {
        const btn = await page.$(sel);
        if (btn) {
          const box = await btn.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            log(
              "D",
              `點擊 (CSS): ${sel} (${Math.round(box.width)}x${Math.round(box.height)})`,
            );
            await btn.click();
            clicked = true;
            break;
          }
        }
      } catch (e) {
        log("D", `選擇器 ${sel} 失敗: ${e.message}`);
      }
    }
  }

  if (!clicked) {
    // 最後嘗試：點擊第一個可見的 SVG 按鈕
    try {
      const allBtns = await page.$$("button");
      for (const btn of allBtns) {
        const box = await btn.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          const text = await btn.evaluate((el) => el.textContent.trim());
          if (!text || text.length < 3) {
            log("D", "點擊空文字按鈕 (可能是新對話)");
            await btn.click();
            clicked = true;
            break;
          }
        }
      }
    } catch (e) {
      log("D", `fallback 點擊失敗: ${e.message}`);
    }
  }

  if (!clicked) {
    log("E", "找不到新對話按鈕");
    return { chatId: null, url: page.url(), method: "click_failed" };
  }

  // 等待 URL 變化（新聊天通常會改變 URL 為 /c/<chat_id>）
  await sleep(2000);
  const currentUrl = page.url();
  let chatId = null;

  // 從 URL 提取 chat_id
  const urlMatch = currentUrl.match(/\/c\/([a-f0-9-]{36})/i);
  if (urlMatch) {
    chatId = urlMatch[1];
    log("I", `從 URL 取得 chat_id: ${chatId}`);
    return { chatId, url: currentUrl, method: "url" };
  }

  // 從 localStorage 找最近聊天的 id
  try {
    const lsId = await page.evaluate(() => {
      try {
        const chats = JSON.parse(localStorage.getItem("chatList") || "[]");
        if (chats.length > 0) return chats[0].id || null;
      } catch {}
      // 嘗試其他可能的 key
      for (const key of ["conversations", "chats", "recentChats", "chatIds"]) {
        try {
          const data = JSON.parse(localStorage.getItem(key) || "null");
          if (Array.isArray(data) && data.length > 0) {
            return data[0].id || data[0].chatId || data[0].chat_id || null;
          }
        } catch {}
      }
      return null;
    });
    if (lsId) {
      chatId = lsId;
      log("I", `從 localStorage 取得 chat_id: ${chatId}`);
      return { chatId, url: currentUrl, method: "localStorage" };
    }
  } catch (e) {
    log("D", `localStorage 讀取失敗: ${e.message}`);
  }

  // 嘗試從頁面元素找 chat_id
  try {
    const domId = await page.evaluate(() => {
      const m = window.location.pathname.match(/\/c\/([a-f0-9-]{36})/i);
      return m ? m[1] : null;
    });
    if (domId) {
      chatId = domId;
      log("I", `從 DOM 取得 chat_id: ${chatId}`);
      return { chatId, url: currentUrl, method: "dom" };
    }
  } catch {}

  log("W", "無法提取 chat_id，返回目前 URL");
  return { chatId: null, url: currentUrl, method: "no_id" };
}

// ── 發送訊息（DOM + Enter） ─────────────────────────────────────────
/**
 * 在輸入框中輸入訊息並按下 Enter 發送
 * @param {import('puppeteer-core').Page} page
 * @param {string} message - 要發送的訊息
 * @param {Object} [opts]
 * @param {string} [opts.chatId] - 指定聊天 ID（若需要先導航）
 * @param {string[]} [opts.inputSelectors] - 輸入框選擇器
 * @param {AbortSignal} [opts.signal] - 中止訊號
 * @returns {Promise<boolean>} 是否成功發送
 */
// P44: chat.qwen.ai 輸入字數限制
// 過去實測 ~50K 字會被拒絕，但現代 SPA 支援較大輸入。
// 策略：先嘗試一次貼上（max 100K），失敗才降級到智慧分段。
// 分段發送的每段是獨立聊天訊息，qwen.ai 對從中斷處開始的內容
// 會回覆「正在理解用户意图并分析输入内容跳过」等拒絕訊息，
// 因此應優先避免分段。
const MAX_INPUT_CHARS = 100000;

export async function sendMessage(page, message, opts = {}) {
  const inputSelectors = opts.inputSelectors || SELECTORS.input;
  const signal = opts.signal || null;

  // P44: 超長訊息直接拒絕（分段發送會導致每段變成獨立訊息，破壞上下文）
  if (message.length > MAX_INPUT_CHARS) {
    log(
      "E",
      `訊息過長 (${message.length}字)，超過限制 ${MAX_INPUT_CHARS}，拒絕發送`,
    );
    return false;
  }

  log("I", `發送訊息 (${message.slice(0, 50)}...)`);

  // 如果指定了 chatId，先導航到該聊天
  if (opts.chatId) {
    const baseUrl = page
      .url()
      .replace(/\/c\/.*$/, "")
      .replace(/\/$/, "");
    const targetUrl = `${baseUrl}/c/${opts.chatId}`;
    if (page.url() !== targetUrl) {
      log("D", `導航到聊天: ${targetUrl}`);
      try {
        await page.goto(targetUrl, {
          waitUntil: "networkidle2",
          timeout: 15000,
        });
        await sleep(1000);
      } catch (e) {
        log("W", `導航失敗: ${e.message}，繼續嘗試`);
      }
    }
  }

  // 找到並點擊輸入框
  let inputEl = null;
  for (const sel of inputSelectors) {
    if (signal?.aborted) return false;
    try {
      const el = await page.$(sel);
      if (el) {
        const box = await el.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          inputEl = el;
          log("D", `找到輸入框: ${sel}`);
          break;
        }
      }
    } catch {}
  }

  if (!inputEl) {
    log("E", "找不到輸入框");
    return false;
  }

  // 聚焦輸入框（用 evaluate.focus 避免 Playwright actionability 檢查在 SPA hydration 時 hang 60s）
  try {
    await page.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (el) el.focus();
      },
      inputSelectors.find((s) => s.includes("textarea")) || "textarea",
    );
  } catch (e) {
    log("W", `聚焦輸入框失敗: ${e.message}，嘗試 click`);
    try {
      await inputEl.click();
    } catch {}
  }

  await sleep(300);

  // 清除現有內容（5s timeout 避免 SPA hydration 時 hang）
  try {
    await page.evaluate(
      () => {
        const active = document.activeElement;
        if (active) {
          if (active.tagName === "TEXTAREA" || active.tagName === "INPUT") {
            active.value = "";
          } else if (active.isContentEditable) {
            active.textContent = "";
          }
        }
      },
      { timeout: 5000 },
    );
  } catch {}

  // 輸入訊息
  // P40: 一律用 paste 模式（直接設 value + input event），避免 page.keyboard.type
  // 逐字觸發 React re-render 導致極慢輸入 (22 字需 ~60s) 或 SPA crash
  // 使用 selector 直接定位 textarea，避免依賴 document.activeElement（初始 page 未 hydration 時為 body）
  let usePaste = true;
  if (usePaste) {
    log("D", `使用 paste 模式 (${message.length}字)`);
    try {
      // focus 已在上面處理，此處直接 paste
      await page.evaluate(
        (msg) => {
          const sel = [
            "textarea.message-input-textarea",
            "textarea",
            "[contenteditable=true]",
          ];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (!el) continue;
            if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
              const native = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
              )?.set;
              if (native) native.call(el, msg);
              else el.value = msg;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = msg;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return; // found and filled
          }
        },
        message,
        { timeout: 5000 },
      );
    } catch (e) {
      log("W", `paste 失敗: ${e.message}，fallback 到 keyboard.type`);
      usePaste = false;
    }

    // P44: paste 驗證 — 確認 textarea 真的有值，否則 SPA 可能拒絕提交
    if (usePaste) {
      try {
        const actualLen = await page.evaluate(() => {
          const ta = document.querySelector("textarea.message-input-textarea");
          return ta?.value?.length || 0;
        });
        if (actualLen === 0) {
          log("W", "paste 後 textarea 仍為空，fallback 到 keyboard.type");
          usePaste = false;
        } else {
          log("D", `paste 驗證: textarea.value.length = ${actualLen}`);
        }
      } catch (e) {
        log("W", `paste 驗證異常: ${e.message}，fallback 到 keyboard.type`);
        usePaste = false;
      }
    }
  }
  if (!usePaste) {
    // P44: keyboard.type fallback 前先聚焦輸入框（避免輸入到 page body）
    try {
      const taSel =
        inputSelectors.find(
          (s) => s.includes("textarea") || s.includes("input"),
        ) || "textarea";
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.focus();
      }, taSel);
      await sleep(200);
    } catch (e) {
      log("D", `fallback focus 失敗: ${e.message}`);
    }
    try {
      await page.keyboard.type(message, { delay: 10 });
    } catch (e) {
      log("W", `鍵盤輸入失敗: ${e.message}，嘗試 JS paste`);
      try {
        await page.evaluate((msg) => {
          const sel = [
            "textarea.message-input-textarea",
            "textarea",
            "[contenteditable=true]",
          ];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (!el) continue;
            if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
              const native = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
              )?.set;
              if (native) native.call(el, msg);
              else el.value = msg;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = msg;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return; // found and filled
          }
        }, message);
      } catch (e2) {
        log("E", `所有輸入方法失敗: ${e2.message}`);
        return false;
      }
    }
  }

  await sleep(500);

  // 按下 Enter
  try {
    await page.keyboard.press("Enter");
    log("D", "按下 Enter 發送");
  } catch (e) {
    log("W", `Enter 失敗: ${e.message}`);
    return false;
  }

  // 驗證：等待頁面穩定後檢查輸入框是否被清空（SPA 接受發送的訊號）
  // 若 Enter 觸發頁面導航（如從首頁到 guest chat），需要等導航完成
  await sleep(2000);
  try {
    const state = await page.evaluate(() => {
      const ta = document.querySelector("textarea.message-input-textarea");
      if (!ta) return { ok: false, reason: "no_textarea" };
      return {
        ok: ta.value.trim() === "",
        valLen: ta.value.length,
        disabled: ta.disabled,
      };
    });
    if (!state.ok) {
      log(
        "W",
        `發送後輸入框未清空 (valLen=${state.valLen}, reason=${state.reason}), 可能發送失敗，嘗試點擊發送按鈕...`,
      );
      // 嘗試點擊發送按鈕作為 fallback
      try {
        // 使用有效的 CSS 選擇器（移除無效的 :has-text()）
        const sendBtn = await page.$(
          'button[type="submit"], button[class*="send"], button[class*="submit"], button[aria-label*="send"], button[aria-label*="發送"]',
        );
        if (sendBtn) {
          const box = await sendBtn.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            await sendBtn.click();
            log("D", "點擊發送按鈕重試");
            await sleep(2000);
            // 再次檢查
            const state2 = await page.evaluate(() => {
              const ta = document.querySelector(
                "textarea.message-input-textarea",
              );
              if (!ta) return { ok: false, reason: "no_textarea" };
              return { ok: ta.value.trim() === "", valLen: ta.value.length };
            });
            if (state2.ok) {
              log("D", "發送成功（點擊按鈕後輸入框已清空）");
              return true;
            }
          }
        }
      } catch (e2) {
        log("W", `點擊發送按鈕失敗: ${e2.message}`);
      }
      // 檢查是否因為每日限額或未登入導致發送被阻擋
      const errText = await page
        .evaluate(() => {
          const last = document.querySelector(
            ".qwen-chat-message-assistant:last-child",
          );
          return last ? last.textContent.trim().slice(0, 150) : "";
        })
        .catch(() => "");
      if (errText) log("W", `頁面錯誤訊息: ${errText}`);
      return false;
    }
    log("D", "發送成功（輸入框已清空）");
  } catch (e) {
    log("D", `發送驗證略過: ${e.message}`);
  }

  return true;
}

// ── 常見錯誤文字偵測（用於快速中止） ──────────────────────────────
const ERROR_PATTERNS = [
  "已達到每日使用限制",
  "daily usage limit",
  "rate limit",
  "too many requests",
  "請稍後再試",
  "please try again later",
  "unauthorized",
  "未授權",
  // P44: SPA 拒絕輸入內容時的錯誤提示
  "檢視Qwen模型開發模式無回應問題跳過",
  "正在理解用户意图并分析输入内容跳过",
  "分析输入内容",
];

function matchesError(text) {
  if (!text) return false;
  const lo = text.toLowerCase();
  return ERROR_PATTERNS.some((p) => lo.includes(p.toLowerCase()));
}

// ── DOM 監控擷取串流回應 ────────────────────────────────────────────
/**
 * 監控 DOM 中 AI 回應的變化，即時回呼文字區塊
 *
 * 策略：追蹤 assistant message 數量變化，等待新訊息出現後監控其文字內容。
 * 避免將舊對話內容誤判為新回應。
 *
 * @param {import('puppeteer-core').Page} page
 * @param {Object} opts
 * @param {string[]} [opts.assistantSelectors] - AI 回應容器選擇器
 * @param {number} [opts.msgCount=0] - 發送前已知的 assistant message 數量
 * @param {number} [opts.pollMs=100] - 輪詢間隔
 * @param {number} [opts.stableMs=2000] - 多長時間無變化視為完成
 * @param {number} [opts.timeout=120000] - 總超時
 * @param {number} [opts.newMsgTimeout=15000] - 等待新 assistant message 的超時（獨立於總超時）
 * @param {number} [opts.thinkTimeout=60000] - 等待 thinking card 完成的超時
 * @param {number} [opts.minMonitorMs=5000] - 最小監控時間（防止思考內容被誤判為穩定回應）
 * @param {AbortSignal} [opts.signal] - 中止訊號
 * @param {Function} opts.onChunk - 收到文字區塊時回呼 ({text, fullText, done})
 * @returns {Promise<{text: string, done: boolean}>}
 */
export async function monitorResponse(page, opts) {
  const {
    assistantSelectors = SELECTORS.assistantMsg,
    msgCount = 0,
    lastAssistantText = "",
    pollMs = 100,
    stableMs = 5000,
    timeout = 120000,
    newMsgTimeout = 15000,
    thinkTimeout = 60000,
    minMonitorMs = 5000,
    signal = null,
    onChunk = () => {},
  } = opts;

  const deadline = now() + timeout;
  const newMsgDeadline = now() + newMsgTimeout;
  const stableThreshold = Math.max(1, Math.round(stableMs / pollMs));
  const minMonitorThreshold = Math.max(1, Math.round(minMonitorMs / pollMs));
  let lastText = "";
  let stableCount = 0;
  let pollCount = 0;
  let started = false;
  let foundNewMsg = false;
  let thinkingCompleted = false;

  let lastFallbackMode = null;
  const thinkStart = now();

  log(
    "I",
    `開始監控 DOM 回應 (msgCount=${msgCount}, timeout=${timeout}ms, newMsgTimeout=${newMsgTimeout}ms)...`,
  );

  while (now() < deadline) {
    if (signal?.aborted) {
      log("W", "監控被中止");
      return { text: lastText, done: false, reason: "aborted" };
    }

    // ── 階段 1: 等待新 assistant message 出現 ──
    // 策略：
    //   1. 優先檢查新 node 出現（curCount > msgCount）— 適用於所有場景
    //   2. 若 msgCount > 0 且 count 沒增加，SPA 可能在重寫既有 node 內容
    //      此時比較 current text 與 lastAssistantText 是否有變化
    if (!foundNewMsg) {
      // 路徑 A：檢查是否出現新 assistant message node（通用邏輯）
      try {
        const curCount = await page.evaluate(
          () =>
            document.querySelectorAll(".qwen-chat-message-assistant").length,
        );
        if (curCount > msgCount) {
          foundNewMsg = true;
          log("D", `新 assistant message (${curCount} > ${msgCount})`);
          await sleep(300);
        }
      } catch {}
      // 路徑 B：多輪對話中 SPA 可能重寫既有 node 而非新增
      // 策略：若 curText 與初始的 lastAssistantText 不同，表示內容已變化
      if (!foundNewMsg && msgCount > 0) {
        const curText = await page
          .evaluate(() => {
            const last = document.querySelector(
              ".qwen-chat-message-assistant:last-child",
            );
            return last ? last.textContent || "" : "";
          })
          .catch(() => "");
        const prevText = opts.lastAssistantText || lastText;
        // 內容從有到無 → SPA 正在清空準備重寫
        if (curText === "" && prevText !== "") {
          lastText = "";
          log("D", "既有 assistant message 被清空，等待新內容");
        }
        // 內容變化且非空 → SPA 已寫入新內容
        else if (curText !== "" && curText !== prevText) {
          foundNewMsg = true;
          lastText = curText;
          log("D", `既有 assistant message 內容更新 (${curText.length}字)`);
        }
      }
      if (!foundNewMsg) {
        if (now() > newMsgDeadline) {
          let errText = "";
          try {
            errText = await page.evaluate(() => {
              const msgs = document.querySelectorAll(
                ".qwen-chat-message-assistant",
              );
              const last = msgs[msgs.length - 1];
              return last ? last.textContent.trim().slice(0, 200) : "";
            });
          } catch {}
          if (matchesError(errText)) {
            log("W", `偵測到錯誤，中止: ${errText.slice(0, 80)}`);
            return {
              text: errText,
              done: true,
              reason: "error_detected",
              error: errText,
            };
          }
          log("W", `等待新 assistant message 超時 (${newMsgTimeout}ms)`);
          return { text: "", done: true, reason: "new_msg_timeout" };
        }
        await sleep(pollMs);
        continue;
      }
    }

    // ── 階段 1.5: 檢查 thinking card 狀態（不阻塞 Phase 2） ──
    // SPA 在模型思考期間會把 thinking 文字寫入回應容器。
    // 如果 thinking 未完成，不標記 done（即使文字穩定），
    // 但 Phase 2 的內容讀取不受影響。
    if (foundNewMsg && !thinkingCompleted) {
      try {
        const done = await page.evaluate(() => {
          // 嘗試多種 DOM 結構：
          // 實際 class 已確認含 -tool-（qwen-chat-thinking-tool-status-card-wraper），
          // 但 completed class 可能不含 -tool-
          // 1. 子節點（最常見）
          const nested = document.querySelector(
            ".qwen-chat-thinking-tool-status-card-wraper .qwen-chat-thinking-status-card-completed",
          );
          if (nested) return true;
          // 2. 同元素：wraper 本身有 completed
          const self = document.querySelector(
            ".qwen-chat-thinking-tool-status-card-wraper.qwen-chat-thinking-status-card-completed",
          );
          if (self) return true;
          // 3. wraper 無 -tool-
          const noTool = document.querySelector(
            ".qwen-chat-thinking-status-card-wraper.qwen-chat-thinking-status-card-completed",
          );
          if (noTool) return true;
          // 4. 直接找 anywhere 的 completed card
          const any = document.querySelector(
            ".qwen-chat-thinking-status-card-completed",
          );
          return !!any;
        });
        if (done) {
          thinkingCompleted = true;
          log("D", "thinking card 已完成");
        } else if (now() - thinkStart > thinkTimeout) {
          thinkingCompleted = true;
          log("W", "等待 thinking card 超時，強制繼續");
        }
      } catch (e) {
        log("D", `thinking 狀態檢查失敗: ${e.message}`);
        thinkingCompleted = true;
      }
    }

    // ── 階段 2: 讀取最新 assistant message 的內容 ──
    // 優先讀取 .response-message-content（正常串流回應），
    // 若不存在則讀取整個 assistant message（錯誤訊息等無 response-message-content 的情境）
    let currentText = "";
    let found = false;
    let usedFallback = false;

    try {
      const state = await page.evaluate(() => {
        const last = document.querySelector(
          ".qwen-chat-message-assistant:last-child",
        );
        if (!last) return { text: "", found: false, exists: false };
        // 優先 try .response-message-content
        const rc = last.querySelector(".response-message-content");
        if (rc) {
          return {
            text: rc.textContent || "",
            found: true,
            exists: true,
            fallback: false,
          };
        }
        // fallback: 深層移除 thinking card 節點，只讀實際回應文字
        // 實際 DOM 中 thinking card 巢狀多層（非直系子節點），且 class 為
        // qwen-chat-thinking-tool-status-card-wraper（含 -tool-），
        // :scope > *:not() 無法正確排除。
        // 解法：clone 整個節點後刪除所有 thinking card subtree 再取 text
        let fallbackText = "";
        try {
          const clone = last.cloneNode(true);
          clone
            .querySelectorAll(
              ".qwen-chat-thinking-tool-status-card-wraper, .qwen-chat-thinking-status-card-wraper",
            )
            .forEach((el) => el.remove());
          fallbackText = clone.textContent || "";
        } catch {
          fallbackText = last.textContent || "";
        }
        const text = fallbackText;
        return {
          text,
          found: text.trim().length > 0,
          exists: true,
          fallback: true,
        };
      });
      currentText = state.text;
      found = state.found;
      usedFallback = state.fallback;
      // 調試：記錄內容讀取模式（每 200 輪或首次有內容時）
      // 避免在 found=true 但 len=0 時持續刷屏
      if (
        pollCount % 200 === 0 ||
        (found && currentText.length > 0 && lastText === "")
      ) {
        log(
          "D",
          `Phase2: ${usedFallback ? "fallback" : "rc"} found=${found} len=${currentText.length}`,
        );
      } else if (found && currentText.length === 0 && pollCount % 200 === 0) {
        // 只在 found=true 且 len=0 時，每 200 輪記錄一次（避免刷屏）
        log(
          "D",
          `Phase2: ${usedFallback ? "fallback" : "rc"} found=${found} len=0 (waiting for content)`,
        );
      }
    } catch (e) {
      log("D", `DOM 讀取錯誤: ${e.message}`);
      await sleep(pollMs);
      continue;
    }

    // 模式轉換偵測：當從 fallback 切換到非 fallback（或相反）時，重置 lastText
    // 因為兩種模式讀取的 text 不同（fallback 含 thinking card），直接 diff 會產出亂碼
    if (lastFallbackMode !== null && usedFallback !== lastFallbackMode) {
      log("D", `回應容器模式轉換: fallback=${usedFallback}, 重置文字追蹤`);
      lastText = currentText;
      lastFallbackMode = usedFallback;
      pollCount = 0;
      await sleep(pollMs);
      continue;
    }
    lastFallbackMode = usedFallback;

    if (found && currentText !== lastText) {
      const newChunk = lastText
        ? currentText.slice(lastText.length)
        : currentText;
      lastText = currentText;
      // P41: SPA 新增空 node 時（currentText="" ≠ lastText），跳過本次迭代
      // 避免 empty chunk 觸發 → 立即 stable 誤判為完成
      if (!started && !newChunk.trim()) {
        await sleep(pollMs);
        continue;
      }
      stableCount = 0;
      pollCount++;
      started = true;

      // 檢查新 chunk 是否包含錯誤訊息
      if (newChunk && newChunk.trim() && matchesError(newChunk)) {
        log("W", `回應內容含錯誤: ${newChunk.slice(0, 80)}`);
        onChunk({ text: newChunk, fullText: currentText, done: false });
        onChunk({ text: "", fullText: currentText, done: true });
        return { text: currentText, done: true, reason: "error_in_response" };
      }

      if (newChunk && newChunk.trim()) {
        onChunk({ text: newChunk, fullText: currentText, done: false });
      }
    } else if (found && currentText === lastText && started) {
      pollCount++;
      stableCount++;
      // 防止在最小監控時間內誤判穩定（SPA 可能在 thinking 完成後短暫停留才開始串流）
      if (stableCount >= stableThreshold && pollCount >= minMonitorThreshold) {
        // P44: thinking 未完成就標記 done → 19-char 陷阱
        // SPA 在 thinking 期間可能暫短顯示 19 chars 的 fallback 文字，
        // 若此時誤判為完成，後續實際回應會被丟棄。
        // 解法：thinking 未完成時重置 stableCount，繼續等待
        if (!thinkingCompleted) {
          stableCount = 0;
          await sleep(pollMs);
          continue;
        }
        // P45: 空內容穩定 → SPA 已建立回應節點但尚未開始串流內容
        // .response-message-content node 存在但 textContent=""，
        // 此時回傳 done 會得到 0 字回應。應繼續等待串流開始。
        if (currentText === "" && found) {
          stableCount = 0;
          await sleep(pollMs);
          continue;
        }
        log(
          "D",
          `回應完成 (${currentText.length}字, 穩定 ${stableCount * pollMs}ms, 總監控 ${pollCount * pollMs}ms)`,
        );
        onChunk({ text: "", fullText: currentText, done: true });
        return { text: currentText, done: true };
      }
    } else if (found && currentText !== lastText && started) {
      pollCount++;
    } else if (started) {
      pollCount++;
    } else if (found) {
      // found=true 但 started=false 且內容未變化（如等待 thinking 完成時）
      // 仍需遞增 pollCount 以觸發定期日誌與超時檢查
      pollCount++;
    }

    // 調試日誌：每 200 輪（~20s）輸出一次監控狀態，避免刷屏
    if (pollCount > 0 && pollCount % 200 === 0) {
      log(
        "D",
        `監控中: found=${found} started=${started} stable=${stableCount} poll=${pollCount} len=${currentText.length} thinkingDone=${thinkingCompleted} fallback=${usedFallback}`,
      );
    }

    if (!found && !thinkingCompleted && pollCount % 200 === 0) {
      log(
        "D",
        `無內容 — 檢查 thinking 狀態 (poll=${pollCount}, elapsed=${now() - thinkStart}ms)`,
      );
    }

    if (!found) {
      pollCount++; // 修復：!found 時也要遞增 pollCount，否則 %200 條件永遠為真
      // P42: 通用 thinking 偵測 — 支援多種 SPA 實作
      // 注意：如果 Phase 1.5 已確認 thinking 完成，跳過此區塊
      // 避免已完成的 thinking card（class 仍含 "think" 字樣）誤觸通用檢測
      if (!thinkingCompleted) {
        try {
          const state = await page.evaluate(() => {
            // 精確 selector（已知 qwen.ai 的 thinking card）
            const exact = document.querySelector(
              ".qwen-chat-thinking-status-card-wraper:not(.qwen-chat-thinking-status-card-completed)",
            );
            if (exact) return "thinking";
            // 通用 fallback：class 包含 thinking/streaming/loading 的可見元素
            const els = document.querySelectorAll(
              '[class*="thinking"],[class*="think"],[class*="streaming"],[class*="generat"],[class*="typing"],[class*="loading"]',
            );
            for (const el of els) {
              if (el.offsetWidth > 0 || el.offsetHeight > 0) return "thinking";
            }
            // 文字 fallback：可見文字包含「思考/生成/thinking/generating」
            const body = document.body?.innerText?.slice(0, 500) || "";
            if (
              /思考中|thinking|generating|生成中|回答中/.test(body) &&
              !body.includes("Sorry, an error")
            ) {
              return "thinking";
            }
            return "";
          });
          if (state === "thinking") {
            await sleep(pollMs);
            continue;
          }
        } catch {}
      }
    }
    if (found && currentText === "" && started) {
      await sleep(pollMs);
      continue;
    }

    await sleep(pollMs);
  }

  log("W", `DOM 監控超時 (${timeout}ms)`);
  if (lastText) {
    onChunk({ text: "", fullText: lastText, done: true });
  }
  return { text: lastText, done: true, reason: "timeout" };
}

// ── 完整流程：發送並取得串流 ─────────────────────────────────────────
/**
 * 發送訊息並監控 DOM 取得串流回應
 * 整合 sendMessage + monitorResponse
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} message
 * @param {Object} [opts]
 * @param {string} [opts.chatId]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} opts.onChunk - ({text, fullText, done}) => void
 * @param {number} [opts.timeout=120000]
 * @returns {Promise<{text: string, done: boolean, error?: string}>}
 */
export async function sendAndMonitor(page, message, opts = {}) {
  const { onChunk = () => {}, signal, timeout = 120000 } = opts;

  // 步驟 0: 記錄發送前 assistant message 數量與最後一條文字
  let msgCount = 0;
  let lastAssistantText = "";
  try {
    const state = await page.evaluate(() => {
      const count = document.querySelectorAll(
        ".qwen-chat-message-assistant",
      ).length;
      const last = document.querySelector(
        ".qwen-chat-message-assistant:last-child",
      );
      return { count, text: last ? last.textContent || "" : "" };
    });
    msgCount = state.count;
    lastAssistantText = state.text;
  } catch {}
  log("D", `發送前 assistant messages: ${msgCount}`);

  // 步驟 1: 發送訊息
  const sent = await sendMessage(page, message, opts);
  if (!sent) {
    const err = "發送訊息失敗";
    log("E", err);
    return { text: "", done: false, error: err };
  }

  // 步驟 2: 監控 DOM 串流（等待新 msg + 追蹤內容變化）
  const result = await monitorResponse(page, {
    assistantSelectors: SELECTORS.assistantMsg,
    msgCount,
    lastAssistantText,
    pollMs: 100,
    stableMs: 2000,
    // 注意：不減 sendMessage 耗時 — AI 生成可能需要 30-60s
    // 外層 Promise.race (runRPA) 已處理整體 deadline，此處需獨立且充足的超時
    timeout: Math.max(timeout, 60000),
    signal,
    onChunk,
  });

  return result;
}

// ── 取得 AI 完整回應文字 ────────────────────────────────────────────
/**
 * 等待 AI 回應完成並回傳完整文字（非串流，方便測試）
 */
export async function waitForFullResponse(page, opts = {}) {
  let fullText = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve({ text: fullText, done: true, reason: "timeout" });
    }, opts.timeout || 60000);

    sendAndMonitor(page, opts.message || "", {
      ...opts,
      chatId: opts.chatId,
      onChunk: ({ text, fullText: ft, done }) => {
        fullText = ft;
        if (done) {
          clearTimeout(timeout);
          resolve({ text: fullText, done: true });
        }
      },
    }).catch((e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

export default {
  discoverSelectors,
  createNewChat,
  sendMessage,
  monitorResponse,
  sendAndMonitor,
  waitForFullResponse,
};
