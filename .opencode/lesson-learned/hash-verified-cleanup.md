# Hash 驗證 + Cleanup 雙機同步機制

## 問題描述

筆電寫入知識/維基/教訓後，桌機拉取時可能因網路問題導致檔案內容不完整或損毀。
直接刪除筆電來源檔案有風險 — 如果桌機收到的是損毀資料，原始資料就遺失了。

## 解決方案

實作 hash 驗證的兩階段同步流程：

1. **拉取階段**：桌機從筆電 GET /api/read 讀取檔案內容
2. **驗證階段**：桌機對內容計算 md5，與回應 header `X-Content-Hash` 比對
3. **清理階段**：驗證通過後，桌機 POST /api/cleanup 通知筆電刪除來源檔

### 關鍵實作細節

```typescript
// peer-puller.ts — 寫入後 hash 驗證
const hash = createHash("md5").update(content).digest("hex");
if (serverHash && hash !== serverHash) {
  console.error(`   ❌ hash 不符: ${serverHash} !== ${hash}`);
  result.errors++;
  continue;
}
await writeFile(localPath, content, "utf-8");
synced.push({ type, path: relPath }); // 驗證通過才加入清理清單
```

```typescript
// api.ts — cleanup 端點
app.post("/api/cleanup", async (req, res) => {
  const { files } = req.body;
  for (const f of files) {
    const target = /* 還原完整路徑 */;
    await rm(target);
    syncedFiles.set(target, true);  // 去重保護
  }
  res.json({ ok: true, deleted: count });
});
```

## 安全設計

- 驗證失敗 → 保留來源檔案，記錄錯誤，不刪除
- 重複 cleanup → 冪等處理（已刪除的檔案再次收到請求時忽略）
- 清理清單只在記憶體中維護（synced[] 陣列），不持久化
- 若桌機當機重啟，synced 陣列丟失 → 來源檔案保留，下次 pull 會重新同步

## 相關檔案

- `telegram-memory-bridge/src/peer-puller.ts` — hash 驗證 + cleanup 通知
- `telegram-memory-bridge/src/api.ts` — POST /api/cleanup 端點
- `ARCHITECTURE.md` — 同步流程規範

## 等級

P4-最佳實踐
