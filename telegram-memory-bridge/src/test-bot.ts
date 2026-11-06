import { readFileSync } from "fs";
import { resolve } from "path";
import { decrypt } from "./encryption.ts";

const envPath = resolve(__dirname, "../.env");
const content = readFileSync(envPath, "utf-8");
const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/);
if (match) {
  const encrypted = match[1].trim();
  console.log("Token prefix:", encrypted.substring(0, 30) + "...");
  const decrypted = decrypt(encrypted);
  console.log("Decrypted prefix:", decrypted.substring(0, 12) + "...");
  const res = await fetch(`https://api.telegram.org/bot${decrypted}/getMe`);
  const data: any = await res.json();
  if (data.ok) {
    console.log("✅ Bot 有效:", data.result.username, "ID:", data.result.id);
  } else {
    console.log("❌ Bot 無效:", data.description);
  }
} else {
  console.log("❌ Token not found");
}
