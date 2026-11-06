/// <reference types="bun" />
// Telegram Memory Bridge — websearch.ts
// 網路搜索核心（Brave Search 免 API Key + webfetch 網頁擷取）

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const BRAVE_URL = "https://search.brave.com/search";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── 網路搜索（Brave Search，免 API Key） ──

export async function webSearch(
  query: string,
  maxResults = 5,
): Promise<SearchResult[]> {
  // 2026-10-25 Fix：Brave 常回 429（免 API Key 限流）→ 多後端依序嘗試
  const errs: string[] = [];
  for (const fn of [brave, duck]) {
    try {
      const out = await fn(query, maxResults);
      if (out.length > 0) return out;
      errs.push(`${fn.name}: 0 筆`);
    } catch (e) {
      errs.push(`${fn.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(errs.join(" / "));
}

async function brave(query: string, max: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, source: "web" });
  const res = await fetch(`${BRAVE_URL}?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  return parseBraveResults(await res.text(), max);
}

// ── DuckDuckGo HTML 後端（Brave 429 時接手） ──

async function duck(query: string, max: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  return parseDuck(await res.text(), max);
}

function parseDuck(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const strip = (s: string) =>
    s
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  for (const m of html.matchAll(re)) {
    if (out.length >= max) break;
    // DDG 會包一層 redirect，取出 uddg 參數
    let url = m[1];
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    const title = strip(m[2]);
    if (title) out.push({ title, url, snippet: strip(m[3]) });
  }
  return out;
}

function parseBraveResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // 用 data-pos 切分每個搜尋結果區塊
  // Brave Search 每個 web 結果用 <div class="snippet ..." data-pos="N" data-type="web">
  const blocks = html.split('data-type="web"');

  for (let i = 1; i < blocks.length && results.length < max; i++) {
    const block = blocks[i];

    // 提取 URL
    const urlMatch = block.match(/<a\s+href="(https?:\/\/[^"]+)"/);
    if (!urlMatch) continue;
    let url = urlMatch[1];

    // 提取標題（從 title attribute 或 inner text）
    const titleMatch = block.match(
      /<div\s+class="title[^"]*"\s+title="([^"]*)"/,
    );
    let title = titleMatch ? titleMatch[1] : "";
    if (!title) {
      // fallback: 直接從 title div 內文提取
      const fallback = block.match(
        /<div\s+class="title[^"]*">\s*([^<]+)\s*<\/div>/,
      );
      if (fallback) title = fallback[1].trim();
    }

    // 提取摘要（generic-snippet > content）
    const snippetMatch = block.match(
      /<div\s+class="content[^"]*">([\s\S]*?)<\/div>/,
    );
    let snippet = "";
    if (snippetMatch) {
      snippet = snippetMatch[1]
        .replace(/<[^>]*>/g, "") // 剝離 HTML 標籤
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/<!---->/g, "") // 移除 Vue/Svelte 註釋節點
        .replace(/<!--\[.*?\]-->/g, "") // 移除區塊註釋
        .replace(/\s+/g, " ")
        .trim();
      // 移除開頭的日期（如 "January 10, 2026 -"）
      snippet = snippet.replace(/^[A-Z][a-z]+ \d+, \d{4} - /, "");
    }

    if (title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

// ── 網頁內容擷取（webfetch） ──

export async function webFetch(url: string, maxLength = 3000): Promise<string> {
  // 自動補上 https://
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // 剝離 HTML 標籤，提取可讀文字
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > maxLength) return text.slice(0, maxLength) + "…";
  return text;
}

// ── 用 Qwen 摘要網頁內容 ──

export async function summarizeWithQwen(
  qwenAsk: (system: string, userMsg: string) => Promise<string>,
  query: string,
  results: SearchResult[],
): Promise<string> {
  const resultText = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    摘要: ${r.snippet}`,
    )
    .join("\n\n");

  const system =
    "你是網路搜索摘要助手。根據搜尋結果回答使用者的問題。" +
    "保持簡潔、條列重點，使用繁體中文。附上參考來源編號。";

  const prompt = [
    `問題: ${query}`,
    "",
    "搜尋結果:",
    resultText,
    "",
    "請根據以上搜尋結果回答問題，附上來源編號。",
  ].join("\n");

  try {
    return await qwenAsk(system, prompt);
  } catch {
    // AI 摘要失敗 → 回退顯示原始結果
    return "";
  }
}
