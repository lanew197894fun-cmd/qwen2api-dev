/**
 * Qwen API Proxy — Cloudflare Worker
 *
 * 用途：作為 chat.qwen.ai 的反向代理，繞過 WAF JS challenge 與每日使用限制
 *
 * 原理：
 *   browser-proxy（RPA 模式）操作真實瀏覽器 UI 發送聊天，消耗「每日對話配額」。
 *   CF Worker 直接轉發 API 請求至 chat.qwen.ai 後端，不走 Web UI，
 *   避開每日使用限制，且不再需要維持 Chrome 頭。
 *
 * 部署方式：
 *   1. 登入 Cloudflare Dashboard → Workers & Pages → 建立應用程式 → 建立 Worker
 *   2. 將此檔案內容貼入編輯器 → 部署
 *   3. 在 qwen2api-dev/qwen2api/.env 中設定：
 *      QWEN_CHAT_PROXY_URL=https://你的worker名稱.workers.dev
 *   4. 重啟 qwen2api（或所有服務）
 *
 * 注意：
 *   - 此 Worker 僅轉發 API 請求，不處理瀏覽器 WAF JS challenge
 *   - 若上游改版可能需要更新路由規則
 *   - Token 仍透過 browser-proxy 的 localStorage 自動續約（data.json）
 *     （不需要停止 browser-proxy，它只負責續約 token，不再代理請求）
 */

// 目標上游
const UPSTREAM = "https://chat.qwen.ai";

// 需要移除的請求頭（Cloudflare 自動添加 + hop-by-hop + 壓縮避免亂碼）
const REMOVE_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-cache-status",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "cdn-loop",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "accept-encoding",
  "content-encoding",
];

// 解壓縮回應（處理 gzip/br/deflate）
async function decompressResponse(response) {
  const encoding = response.headers.get("content-encoding") || "";
  const body = response.body;

  if (!body) return new Response(null, response);

  // 如果沒有壓縮，直接返回
  if (!encoding) {
    return new Response(body, response);
  }

  try {
    // 使用 DecompressionStream 解壓縮（支援 gzip, deflate, br）
    const stream = body.pipeThrough(new DecompressionStream(encoding));
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("content-encoding");
    newHeaders.delete("content-length"); // 長度會改變
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (e) {
    // 解壓縮失敗，返回原始回應
    console.warn(`Decompression failed for ${encoding}: ${e.message}`);
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrl = `${UPSTREAM}${url.pathname}${url.search}`;

    // 複製並清理請求頭
    const headers = new Headers(request.headers);
    for (const h of REMOVE_HEADERS) headers.delete(h);

    // 確保 Host 指向上游
    headers.set("Host", new URL(UPSTREAM).host);

    // 保留原始來源以供上游驗證
    if (!headers.has("Origin")) {
      headers.set("Origin", UPSTREAM);
    }
    if (!headers.has("Referer")) {
      headers.set("Referer", `${UPSTREAM}/c/guest`);
    }

    // 建立新請求
    const proxyReq = new Request(targetUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
      redirect: "manual",
    });

    try {
      // 發送請求到上游
      const resp = await fetch(proxyReq);

      // 解壓縮回應（關鍵：chat.qwen.ai 可能忽略 accept-encoding 仍回傳壓縮內容）
      const decompressed = await decompressResponse(resp);

      // 複製回應頭（保留 SSE Content-Type 等）
      const respHeaders = new Headers(decompressed.headers);
      // 移除 CF 自動添加的頭
      respHeaders.delete("cf-ray");
      respHeaders.delete("cf-cache-status");
      respHeaders.delete("content-encoding");
      respHeaders.delete("transfer-encoding");

      return new Response(decompressed.body, {
        status: decompressed.status,
        statusText: decompressed.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "upstream_error",
          message: err.message,
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
