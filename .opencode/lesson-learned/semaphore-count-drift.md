# Semaphore 計數漂移導致模型 hang 住

## 發生情境

Telegram bot 執行 `/run lesson_save` 等指令時，模型完全停止回應。

## 錯誤做法

在 `store.ts` 的 `qwenAsk()` 中同時使用硬超時 setTimeout + semRelease 和 semAcquire，
兩個 timeout 機制互相競爭：硬超時釋放還沒 acquire 的 slot，acquire 成功後又加回計數。

## 後果

多次超時後 semActive 偏離真實值，所有新請求永遠拿不到 slot，模型完全 hang 住。

## 正確做法

移除硬超時保護，只靠 semAcquire 內建 timeout + Promise.race API timeout 兜底。

```typescript
// ✅ 正確
await semAcquire(HARD_TIMEOUT_MS);
startCall();
try {
  const result = await Promise.race([
    this.fetchWithRetry(model, system, userMsg, timeoutMs, maxRetries, gov),
    requestTimeout(HARD_TIMEOUT_MS),
  ]);
  return result;
} finally {
  semRelease();
  endCall();
}
```

## 預防措施

- semRelease 必須與 semAcquire 嚴格成對
- 超時處理不當會破壞計數，導致整個系統 hang 住
- 不要在 setTimeout 中直接操作 semaphore 計數

## 等級

P1-功能錯誤

## 相關檔案

`independent/qwen2api-dev/telegram-memory-bridge/src/store.ts`
