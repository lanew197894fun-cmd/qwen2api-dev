/**
 * 上游原始回應探測：直接 POST chat.qwen.ai，dump status/headers/原始 body
 * 用途：判定「回傳空內容」的主因（WAF HTML / 錯誤 JSON / 純 SSE 無內容）
 * 用法：bun test/raw-upstream.probe.js [model]
 */
const axios = require("axios");
const accountManager = require("../src/utils/account.js");
const {
  getCachedChatId,
  invalidateChatId,
} = require("../src/utils/request.js");
const {
  getSsxmodItna,
  getSsxmodItna2,
} = require("../src/utils/ssxmod-manager");
const { getChatBaseUrl, getProxyAgent } = require("../src/utils/proxy-helper");
const { generateUUID } = require("../src/utils/tools.js");

const MODEL = process.argv[2] || "qwen3.6-plus";

const dump = (label, value) => console.log(`\n===== ${label} =====\n${value}`);

(async () => {
  // 等帳戶初始化
  await new Promise((r) => setTimeout(r, 3000));

  const account = accountManager.getAccount();
  if (!account) {
    console.log("❌ 無可用帳戶");
    process.exit(1);
  }
  let token = account.token;
  if (accountManager.tokenManager?.ensureFreshToken) {
    token = await accountManager.tokenManager.ensureFreshToken(account);
  }
  console.log(
    `帳戶: ${account.email} | token: ${String(token).slice(0, 24)}...`,
  );

  // 1) 模型列表探測
  try {
    const base = getChatBaseUrl();
    const ml = await axios.get(`${base}/api/v2/configs/`, {
      timeout: 15000,
      headers: { authorization: `Bearer ${token}`, cookie: `token=${token}` },
    });
    const arr = Array.isArray(ml.data) ? ml.data : ml.data?.data;
    const names = Array.isArray(arr)
      ? arr.map((m) => m.name || m.id || m).slice(0, 30)
      : String(JSON.stringify(ml.data)).slice(0, 300);
    dump("模型列表 /api/v2/configs/", JSON.stringify(names));
  } catch (e) {
    dump(
      "模型列表失敗",
      `${e.response?.status || ""} ${e.message} body=${String(e.response?.data || "").slice(0, 300)}`,
    );
  }

  // 2) 建立新 chat_id（繞過快取）
  invalidateChatId(MODEL);
  const chatId = await getCachedChatId(token, MODEL, account);
  dump("chat_id", chatId || "(null)");
  if (!chatId) process.exit(1);

  // 3) 原始 SSE POST
  const base = getChatBaseUrl();
  const agent = getProxyAgent(account);
  const headers = {
    "sec-ch-ua-platform": '"Windows"',
    authorization: `Bearer ${token}`,
    referer: `${base}/`,
    "accept-language": "zh-CN,zh;q=0.9",
    "sec-ch-ua":
      '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "content-type": "application/json",
    "bx-v": "2.5.36",
    accept: "text/event-stream",
    "accept-encoding": "gzip, deflate, br, zstd",
    source: "web",
    version: "0.2.63",
    timezone: new Date().toString().replace(/GMT\+0800/, "GMT+0800"),
    "x-request-id": generateUUID(),
    connection: "keep-alive",
    cookie: `token=${token};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
    host: base.replace("https://", ""),
    origin: base,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-accel-buffering": "no",
  };
  const payload = {
    model: MODEL,
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    stream: true,
    chat_id: chatId,
    chat_mode: "normal",
    chat_type: "t2t",
    timestamp: Date.now(),
  };

  const cfg = {
    headers,
    responseType: "stream",
    timeout: 60000,
  };
  if (agent) {
    cfg.httpsAgent = agent;
    cfg.proxy = false;
  }

  try {
    const t0 = Date.now();
    const resp = await axios.post(
      `${base}/api/v2/chat/completions?chat_id=${chatId}`,
      payload,
      cfg,
    );
    dump("HTTP 狀態", `${resp.status} | 逾時? no | ${Date.now() - t0}ms`);
    dump("回應 headers", JSON.stringify(resp.headers, null, 1).slice(0, 1200));

    const raw = await new Promise((resolve) => {
      let buf = "";
      const tm = setTimeout(() => resolve(buf + "\n<<<8s TIMEOUT>>>"), 8000);
      resp.data.on("data", (c) => {
        buf += c.toString();
        if (buf.length > 6000) {
          clearTimeout(tm);
          resp.data.destroy();
          resolve(buf);
        }
      });
      resp.data.on("end", () => {
        clearTimeout(tm);
        resolve(buf + "\n<<<END>>>");
      });
      resp.data.on("error", (e) => {
        clearTimeout(tm);
        resolve(buf + `\n<<<STREAM ERROR: ${e.message}>>>`);
      });
    });
    dump("原始 body（前 6000 字）", raw.slice(0, 6000));
    const hasContent = /"content"\s*:\s*"[^"]+"/.test(raw);
    dump(
      "判定",
      `有內容=${hasContent} | body 長度=${raw.length} | 是否 WAF HTML=${raw.includes("aliyun_waf")}`,
    );
  } catch (e) {
    const body = e.response?.data;
    let text = "";
    if (body) {
      text =
        typeof body === "string"
          ? body
          : body instanceof require("stream").Readable
            ? await new Promise((r) => {
                let b = "";
                body.on("data", (c) => (b += c));
                body.on("end", () => r(b));
                body.on("error", () => r(b));
                setTimeout(() => r(b), 5000);
              })
            : JSON.stringify(body);
    }
    dump(
      "POST 失敗",
      `status=${e.response?.status || e.code} msg=${e.message}\nbody=${text.slice(0, 3000)}`,
    );
  }
  process.exit(0);
})();
