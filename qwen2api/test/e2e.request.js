/**
 * 端到端：真實打 chat-proxy → qwen2api → Qwen 上游
 */
const http = require("http");

const body = JSON.stringify({
  model: "qwen-max",
  messages: [{ role: "user", content: "回覆：OK" }],
  stream: false,
});

const req = http.request(
  {
    host: "127.0.0.1",
    port: 3456,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: "Bearer test",
    },
    timeout: 180000,
  },
  (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      console.log("HTTP:", res.statusCode);
      try {
        const j = JSON.parse(d);
        console.log("回覆:", j.choices?.[0]?.message?.content?.slice(0, 200) || JSON.stringify(j).slice(0, 300));
        console.log("用量:", JSON.stringify(j.usage || {}));
      } catch {
        console.log("原始:", d.slice(0, 400));
      }
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);
req.on("timeout", () => { console.log("❌ 逾時"); req.destroy(); process.exit(1); });
req.on("error", (e) => { console.log("❌", e.message); process.exit(1); });
req.write(body);
req.end();
