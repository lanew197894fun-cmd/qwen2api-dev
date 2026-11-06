import fs from "fs";

const body = {
  model: "qwen3.7-plus",
  messages: [{ role: "user", content: "只回覆兩個字：成功" }],
  stream: false,
};

const t0 = Date.now();
const res = await fetch("http://127.0.0.1:3000/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();
fs.writeFileSync("/tmp/resp.json", text);
console.log("status:", res.status, "|", Date.now() - t0, "ms");
console.log("body:", text.slice(0, 700));
