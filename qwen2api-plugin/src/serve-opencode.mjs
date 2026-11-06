/**
 * serve-opencode.mjs — 輕量檔案伺服器
 *
 * 透過 Tailscale VPN 分享 .opencode 目錄（知識庫、維基、記憶）
 * 僅綁定 tailscale0 網卡，不暴露到外網
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { networkInterfaces } from "node:os";

// ─── 路徑 ───
import { OPENCODE_DIR } from "./config/paths.js";

const ROOT = path.resolve(process.env.OPENCODE_DIR || OPENCODE_DIR);
const PORT = parseInt(process.env.PORT || "7777", 10);

// 自動取得 Tailscale IP
const getTailscaleIP = () => {
  const nets = networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!name.startsWith("tailscale")) continue;
    for (const a of addrs || []) {
      if (a.family === "IPv4" && a.internal === false) return a.address;
    }
  }
  return "127.0.0.1";
};

const HOST = getTailscaleIP();

// MIME types
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
};

const serveFile = (res, fp, stats) => {
  const ext = path.extname(fp).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const stream = fs.createReadStream(fp);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stats.size,
    "Cache-Control": "no-cache",
  });
  stream.pipe(res);
};

const listDir = (res, relPath, absPath) => {
  const items = fs.readdirSync(absPath, { withFileTypes: true });
  const entries = items
    .map((e) => {
      const name = e.name;
      const full = path.join(absPath, name);
      let stats;
      try {
        stats = fs.statSync(full);
      } catch {
        return null;
      }
      const isDir = stats.isDirectory();
      const size = isDir ? "-" : formatSize(stats.size);
      const mtime = stats.mtime.toISOString().replace("T", " ").slice(0, 19);
      const encoded = encodeURIComponent(name);
      const href = path.join(relPath, name).replace(/\\/g, "/");
      return { name, href, isDir, size, mtime };
    })
    .filter(Boolean);

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<title>Index of /${relPath}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
a { text-decoration: none; color: #0366d6; }
a:hover { text-decoration: underline; }
table { border-collapse: collapse; width: 100%; max-width: 900px; }
th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid #e0e0e0; }
th { background: #f6f8fa; position: sticky; top: 0; }
.dir { font-weight: bold; }
.size, .mtime { color: #666; font-size: 0.9em; }
.icon { width: 20px; text-align: center; }
body.dark { background: #1a1a2e; color: #e0e0e0; }
.dark a { color: #58a6ff; }
.dark th { background: #2d2d44; }
.dark td { border-color: #3d3d54; }
.dark .size, .dark .mtime { color: #999; }
</style>
</head>
<body class="dark">
<h1>📁 Index of /${relPath}</h1>
<table>
<tr><th>Name</th><th>Size</th><th>Modified</th></tr>
${
  relPath !== ""
    ? `<tr><td colspan="3"><a href="${path.posix.join("..", relPath.split("/").slice(0, -1).join("/")) || "."}">⬆ ..</a></td></tr>`
    : ""
}
${entries
  .map(
    (e) =>
      `<tr><td class="${e.isDir ? "dir" : ""}"><span class="icon">${
        e.isDir ? "📁" : "📄"
      }</span> <a href="${e.href}">${e.name}${e.isDir ? "/" : ""}</a></td><td class="size">${e.size}</td><td class="mtime">${e.mtime}</td></tr>`,
  )
  .join("\n")}
</table>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const handler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");

  // Security: prevent path traversal
  const safe = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const absPath = path.join(ROOT, safe);

  // Ensure we stay within ROOT
  if (!absPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stats = fs.statSync(absPath);
    if (stats.isDirectory()) {
      listDir(res, safe, absPath);
    } else {
      serveFile(res, absPath, stats);
    }
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
};

const server = http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`📂 OpenCode 檔案伺服器啟動`);
  console.log(`   網址: http://${HOST}:${PORT}/`);
  console.log(`   根目錄: ${ROOT}`);
  console.log(`   安全綁定: ${HOST} (tailscale0 網卡)`);
  console.log(`   僅限 Tailscale 網路存取，外網不可達`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 伺服器關閉");
  server.close();
  process.exit(0);
});
