/**
 * 手動 Cookie/Token 注入端點
 *
 * 讓使用者直接從瀏覽器 DevTools 貼上 cookies JSON + token，
 * 無需透過 AI 或手動編輯 data.json 即可更新帳戶認證。
 */
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const accountManager = require("../utils/account");
const { logger } = require("../utils/logger");
const { adminKeyVerify } = require("../middlewares/authorization");

// 跳到 Qwen 的 cookies（domain 包含 qwen.ai 或 chat.qwen.ai）
const QWEN_DOMAINS = [".qwen.ai", "chat.qwen.ai"];

/**
 * 從瀏覽器 DevTools 格式的 cookies 陣列中，
 * 過濾出 qwen.ai 相關的 cookie，轉為扁平 key-value 物件。
 *
 * 輸入格式（Chrome DevTools → Application → Cookies → 全選複製）：
 *   [{ domain, name, value, ... }, ...]
 *
 * 輸出格式：
 *   { cna: 'xxx', ssxmod_itna: 'xxx', ... }
 */
const extractQwenCookies = (cookiesArr) => {
  if (!Array.isArray(cookiesArr) || cookiesArr.length === 0) return {};

  const result = {};
  for (const c of cookiesArr) {
    if (!c || !c.name) continue;
    // 只取 qwen 域名的 cookie，跳過無關的
    const domain = (c.domain || "").toLowerCase();
    const inScope = QWEN_DOMAINS.some(
      (d) => domain === d || domain.endsWith("." + d),
    );
    if (!inScope) continue;
    result[c.name] = c.value;
  }
  return result;
};

/**
 * POST /api/injectCookies
 * 手動注入 cookies + token 到指定帳戶
 *
 * Body:
 *   {
 *     email: string,        // 帳戶標識（如 qwen-free-2）
 *     token?: string,       // JWT token（從 Application → Cookies → token 複製）
 *     cookies: object[],    // 瀏覽器 cookies JSON 陣列
 *     password?: string,    // 選填密碼
 *     expires?: number      // 選填過期 timestamp，預設從 token 解碼
 *   }
 */
router.post("/injectCookies", adminKeyVerify, async (req, res) => {
  try {
    const {
      email,
      token,
      cookies: rawCookies,
      password,
      expires: manualExpires,
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: "缺少 email 參數（帳戶標識）" });
    }
    if (
      !token &&
      (!rawCookies || (Array.isArray(rawCookies) && rawCookies.length === 0))
    ) {
      return res
        .status(400)
        .json({ error: "至少要提供 token 或 cookies 其中之一" });
    }

    // 解析 cookies
    const parsedCookies = extractQwenCookies(rawCookies);
    const cookieCount = Object.keys(parsedCookies).length;

    // 如果 cookies 中有 token cookie 且未單獨提供 token → 自動提取
    const finalToken = token || parsedCookies.token || "";

    // 解碼 token 取得過期時間
    let expires = manualExpires || 0;
    if (finalToken) {
      try {
        const parts = finalToken.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString(),
          );
          expires = payload.exp || 0;
        }
      } catch (_) {
        // token 解碼失敗，日期可能不對，但還可以接受
      }
    }

    // 查詢現有帳戶
    const existing = accountManager.accountTokens.find(
      (a) => a.email === email,
    );

    if (existing) {
      // 更新現有帳戶
      if (finalToken) {
        existing.token = finalToken;
        existing.expires = expires || existing.expires;
      }
      if (Object.keys(parsedCookies).length > 0) {
        existing.cookies = { ...(existing.cookies || {}), ...parsedCookies };
      }
      if (password) {
        existing.password = password;
      }
      // 更新 loginMethod（避免覆蓋原值）
      if (!existing.loginMethod) {
        existing.loginMethod = "inject";
      }

      // 注入新 cookie 代表使用者已重新登入 → 清掉 revoked/冷卻標記，
      // 否則 rotator 會持續把此帳戶判為不可用，重注入也無法復原。
      existing.tokenError = null;
      existing._refreshPromise = null;
      accountManager.accountRotator.resetFailures(email);
      logger.info(`已清除 ${email} 的認證錯誤標記`, "INJECT");

      // 持久化到 data.json
      const DataPersistence = require("../utils/data-persistence");
      const dp = new DataPersistence();
      await dp.saveAccount(email, {
        password: existing.password,
        token: existing.token,
        expires: existing.expires,
        cookies: existing.cookies,
        proxy: existing.proxy ?? null,
      });

      logger.success(
        `手動注入成功：${email}（token ${finalToken ? "✅" : "❌"}，cookies ${cookieCount} 個${!token && finalToken ? "，token 從 cookies 自動提取" : ""}）`,
        "INJECT",
      );
      res.json({
        success: true,
        email,
        action: "updated",
        tokenUpdated: !!finalToken,
        cookieCount,
        expires: expires ? new Date(expires * 1000).toISOString() : null,
      });
    } else {
      // 建立新帳戶
      const newAccount = {
        email,
        password: password || "",
        token: finalToken || "",
        expires: expires || 0,
        proxy: null,
        cli_unavailable_reason: "unsupported",
        loginMethod: "inject",
        cookies: parsedCookies,
        stats: {
          chat: { input: 0, output: 0 },
          cli: { calls: 0, input: 0, output: 0 },
        },
      };

      accountManager.accountTokens.push(newAccount);
      accountManager.accountRotator.setAccounts(accountManager.accountTokens);

      // 持久化
      const DataPersistence = require("../utils/data-persistence");
      const dp = new DataPersistence();
      await dp.saveAccount(email, newAccount);

      logger.success(
        `手動注入建立新帳戶：${email}（token ${finalToken ? "✅" : "❌"}，cookies ${cookieCount} 個${!token && finalToken ? "，token 從 cookies 自動提取" : ""}）`,
        "INJECT",
      );
      res.json({
        success: true,
        email,
        action: "created",
        tokenUpdated: !!finalToken,
        cookieCount,
        expires: expires ? new Date(expires * 1000).toISOString() : null,
      });
    }
  } catch (error) {
    logger.error(`手動注入失敗：${error.message}`, "INJECT", "", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/injectCookies/accounts
 * 列出所有帳戶（簡潔版，供注入頁面下拉選單使用）
 */
router.get("/injectCookies/accounts", adminKeyVerify, (req, res) => {
  const list = accountManager.accountTokens.map((a) => ({
    email: a.email,
    hasToken: !!a.token,
    tokenExpires: a.expires ? new Date(a.expires * 1000).toISOString() : null,
    cookieCount: a.cookies ? Object.keys(a.cookies).length : 0,
  }));
  res.json({ accounts: list });
});

module.exports = router;
