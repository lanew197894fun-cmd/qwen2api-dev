/**
 * Cloudflare Worker — 阿里雲 WAF 反向代理（v2，修復串流與編碼問題）
 *
 * ════════════════════════════════════════════════════════════════
 *  目的：繞過阿里雲 WAF 對 chat.qwen.ai API 的阻擋
 *  原理：Cloudflare 全球邊緣網路 → 阿里雲 WAF 不攔 Cloudflare IP
 * ════════════════════════════════════════════════════════════════
 *
 * ─── 部署方式 ───
 *   1. 登入 https://dash.cloudflare.com → Workers & Pages
 *   2. Create Application → Create Worker
 *   3. 貼上此檔案完整內容，覆蓋預設模板
 *   4. 命名為「qwen-proxy」，Save and Deploy
 *   5. 複製 Worker URL → 設定到 qwen2api/.env 的 QWEN_CHAT_PROXY_URL
 */

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
    try {
      const url = new URL(request.url);
      const targetUrl = "https://chat.qwen.ai" + url.pathname + url.search;

      // 讀取請求 body（避免 stream 消費問題）
      let body = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        body = await request.text().catch(() => null);
      }

      // 建構轉發 headers
      const headers = new Headers(request.headers);
      headers.set("Host", "chat.qwen.ai");
      headers.set("Origin", "https://chat.qwen.ai");
      headers.set("Referer", "https://chat.qwen.ai/c/guest");
      headers.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      );
      headers.set("Accept-Encoding", "gzip"); // 只接受 gzip，避免 brotli 解碼問題
      headers.delete("CF-Connecting-IP");
      headers.delete("CF-Ray");
      headers.delete("CF-Visitor");
      headers.delete("CF-Worker");

      // 建構轉發請求
      const proxyReq = new Request(targetUrl, {
        method: request.method,
        headers,
        body,
        redirect: "follow",
      });

      const resp = await fetch(proxyReq);

      // 解壓縮回應（關鍵：chat.qwen.ai 可能忽略 accept-encoding 仍回傳壓縮內容）
      const decompressed = await decompressResponse(resp);

      // 複製回應 headers
      const respHeaders = new Headers(decompressed.headers);
      respHeaders.delete("set-cookie");
      respHeaders.delete("alt-svc");
      respHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(decompressed.body, {
        status: decompressed.status,
        statusText: decompressed.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Proxy error",
          message: err?.message || String(err),
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
