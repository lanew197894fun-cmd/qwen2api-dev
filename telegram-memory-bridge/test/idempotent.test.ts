// 內容冪等性驗證
import { test, expect, afterAll } from "bun:test";
import { MemStore } from "../src/store";
import { resolve } from "path";
import { tmpdir } from "os";
import { rm } from "fs/promises";
import { existsSync } from "fs";

const DIR = resolve(tmpdir(), `tmb-idem-${Date.now()}`);

afterAll(async () => {
  if (existsSync(DIR)) await rm(DIR, { recursive: true, force: true });
});

test("P0: 同內容重複 store 被跳過（冪等）", async () => {
  const s = new MemStore(DIR);
  await s.init();
  const a = await s.store("測試冪等性記憶 ABC", { category: "fact", tags: ["t"] });
  const b = await s.store("測試冪等性記憶 ABC", { category: "fact", tags: ["t"] });
  console.log(`[測試] 第1次 skipped=${a.skipped === true}, 第2次 skipped=${b.skipped === true}`);
  expect(a.skipped).toBeUndefined();
  expect(b.skipped).toBe(true);
  expect(b.id).toBe(a.id);
  expect((await s.list()).length).toBe(1);
}, 15000);

test("P0: 不同內容正常寫入", async () => {
  const s = new MemStore(DIR);
  const a = await s.store("另一筆不同記憶 XYZ", { category: "fact" });
  expect(a.skipped).toBeUndefined();
  expect((await s.list()).length).toBe(2);
}, 15000);

test("P0: 標籤順序不影響雜湊（去重穩健）", async () => {
  const s = new MemStore(DIR);
  await s.store("標籤順序測試記憶", { category: "fact", tags: ["b", "a"] });
  const dup = await s.store("標籤順序測試記憶", { category: "fact", tags: ["a", "b"] });
  expect(dup.skipped).toBe(true);
}, 15000);
