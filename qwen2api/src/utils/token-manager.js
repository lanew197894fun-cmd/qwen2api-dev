const axios = require("axios");
const { sha256Encrypt, JwtDecode } = require("./tools");
const { logger } = require("./logger");
const {
  getProxyAgent,
  getChatBaseUrl,
  applyProxyToAxiosConfig,
} = require("./proxy-helper");

/**
 * 令牌管理器
 * 負責令牌的取得、驗證、重新整理等操作
 */
class TokenManager {
  constructor() {
    this.defaultHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
    };
    // 持久化回呼：由 Account 注入（避免循環依賴），
    // 讓 refresh_token 輪替後可以落盤，否則重啟必然用舊 token → TOKEN_REVOKED
    this.persistHook = null;
  }

  /**
   * 持久化帳戶欄位（失敗不中斷主流程）
   * @param {string} email
   * @param {Object} patch
   * @private
   */
  async _persist(email, patch) {
    if (!this.persistHook || !email) return false;
    try {
      return await this.persistHook(email, patch);
    } catch (error) {
      logger.error(`刷新令牌持久化失敗: ${email}`, "TOKEN", "", error);
      return false;
    }
  }

  /**
   * 取得登入端點
   * @returns {string} 登入端點URL
   */
  get loginEndpoint() {
    return `${getChatBaseUrl()}/api/v1/auths/signin`;
  }

  /**
   * 使用者登入取得令牌
   * @param {string} email - 郵箱
   * @param {string} password - 密碼
   * @param {Object} [account] - 帳戶物件（用於解析帳號級代理；為空時回退到全域 PROXY_URL）
   * @returns {Promise<string|null>} 令牌或null
   */
  async login(email, password, account) {
    try {
      const proxyAgent = getProxyAgent(account);
      const requestConfig = {
        headers: this.defaultHeaders,
        timeout: 10000, // 10秒逾時
      };

      // 新增代理配置
      if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent;
        requestConfig.proxy = false;
      }

      const response = await axios.post(
        this.loginEndpoint,
        {
          email: email,
          password: sha256Encrypt(password),
        },
        requestConfig,
      );

      if (response.data && response.data.token) {
        logger.success(`${email} 登入成功：${response.data.token}`, "AUTH");
        return response.data.token;
      } else {
        logger.error(`${email} 登入回應缺少令牌`, "AUTH");
        return null;
      }
    } catch (error) {
      if (error.response) {
        logger.error(
          `${email} 登入失敗 (${error.response.status})`,
          "AUTH",
          "",
          error,
        );
      } else if (error.request) {
        logger.error(`${email} 登入失敗: 網絡請求逾時或無回應`, "AUTH");
      } else {
        logger.error(`${email} 登入失敗`, "AUTH", "", error);
      }
      return null;
    }
  }

  /**
   * 驗證令牌是否有效
   * @param {string} token - JWT令牌
   * @returns {Object|null} 解碼後的令牌資訊或null
   */
  validateToken(token) {
    try {
      if (!token) return null;

      const decoded = JwtDecode(token);
      if (!decoded || !decoded.exp) {
        return null;
      }

      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp <= now) {
        return null; // 令牌已過期
      }

      return decoded;
    } catch (error) {
      logger.error("令牌驗證失敗", "TOKEN", "", error);
      return null;
    }
  }

  /**
   * 檢查令牌是否即將過期
   * @param {string} token - JWT令牌
   * @param {number} thresholdHours - 過期閾值（小時）
   * @returns {boolean} 是否即將過期
   */
  isTokenExpiringSoon(token, thresholdHours = 6) {
    const decoded = this.validateToken(token);
    if (!decoded) return true; // 無效令牌視為即將過期

    const now = Math.floor(Date.now() / 1000);
    const thresholdSeconds = thresholdHours * 60 * 60;
    return decoded.exp - now < thresholdSeconds;
  }

  /**
   * 取得令牌剩餘有效時間（小時）
   * @param {string} token - JWT令牌
   * @returns {number} 剩餘小時數，-1表示無效令牌
   */
  getTokenRemainingHours(token) {
    const decoded = this.validateToken(token);
    if (!decoded) return -1;

    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = decoded.exp - now;
    return Math.max(0, Math.round(remainingSeconds / 3600));
  }

  /**
   * 重新整理單個帳戶的令牌
   * @param {Object} account - 帳戶物件 {email, password, token, expires}
   * @returns {Promise<Object|null>} 更新後的帳戶物件或null
   */
  async refreshToken(account) {
    try {
      const newToken = await this.login(
        account.email,
        account.password,
        account,
      );
      if (!newToken) {
        return null;
      }

      const decoded = this.validateToken(newToken);
      if (!decoded) {
        logger.error(`重新整理後的令牌無效: ${account.email}`, "TOKEN");
        return null;
      }

      const updatedAccount = {
        ...account,
        token: newToken,
        expires: decoded.exp,
      };

      const remainingHours = this.getTokenRemainingHours(newToken);
      logger.success(
        `令牌重新整理成功: ${account.email} (有效期: ${remainingHours}小時)`,
        "TOKEN",
      );

      return updatedAccount;
    } catch (error) {
      logger.error(`重新整理令牌失敗 (${account.email})`, "TOKEN", "", error);
      return null;
    }
  }

  /**
   * 批量重新整理即將過期的令牌
   * @param {Array} accounts - 帳戶列表
   * @param {number} thresholdHours - 過期閾值（小時）
   * @param {Function} onEachRefresh - 每次重新整理成功後的回調函式 (updatedAccount, index, total) => void
   * @returns {Promise<Object>} 重新整理結果 {refreshed: Array, failed: Array}
   */
  async batchRefreshTokens(
    accounts,
    thresholdHours = 24,
    onEachRefresh = null,
  ) {
    const needsRefresh = accounts.filter((account) =>
      this.isTokenExpiringSoon(account.token, thresholdHours),
    );

    if (needsRefresh.length === 0) {
      logger.info("沒有需要重新整理的令牌", "TOKEN");
      return { refreshed: [], failed: [] };
    }

    logger.info(`發現 ${needsRefresh.length} 個令牌需要重新整理`, "TOKEN");

    const refreshed = [];
    const failed = [];

    for (let i = 0; i < needsRefresh.length; i++) {
      const account = needsRefresh[i];
      const updatedAccount = await this.refreshToken(account);

      if (updatedAccount) {
        refreshed.push(updatedAccount);

        // 如果提供了回調函式，立即調用
        if (onEachRefresh && typeof onEachRefresh === "function") {
          try {
            await onEachRefresh(updatedAccount, i + 1, needsRefresh.length);
          } catch (error) {
            logger.error(
              `重新整理回調函式執行失敗 (${account.email})`,
              "TOKEN",
              "",
              error,
            );
          }
        }
      } else {
        failed.push(account);
      }

      // 新增延遲避免請求過於頻繁
      await this._delay(1000);
    }

    logger.success(
      `令牌重新整理完成: 成功 ${refreshed.length} 個，失敗 ${failed.length} 個`,
      "TOKEN",
    );
    return { refreshed, failed };
  }

  /**
   * 取得健康的令牌統計資訊
   * @param {Array} accounts - 帳戶列表
   * @returns {Object} 統計資訊
   */
  getTokenHealthStats(accounts) {
    const stats = {
      total: accounts.length,
      valid: 0,
      expired: 0,
      expiringSoon: 0,
      invalid: 0,
    };

    accounts.forEach((account) => {
      if (!account.token) {
        stats.invalid++;
        return;
      }

      const decoded = this.validateToken(account.token);
      if (!decoded) {
        stats.invalid++;
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp <= now) {
        stats.expired++;
      } else if (this.isTokenExpiringSoon(account.token, 6)) {
        stats.expiringSoon++;
      } else {
        stats.valid++;
      }
    });

    return stats;
  }

  /**
   * 取得 refresh 端點URL
   *
   * Qwen 改版後 access token 只能透過 httpOnly refresh_token cookie 換取，
   * 無法用 email/password 登入（社群帳號已全面被拒 400）。
   *
   * @returns {string} refresh 端點URL
   */
  get refreshEndpoint() {
    return `https://auth.qwen.ai/api/v2/auths/refresh`;
  }

  /**
   * 解析 refresh 回應中的權杖資料
   *
   * Qwen 會回 HTTP 200 但在 header 標註真實狀態（x-actual-status-code: 401 +
   * x-error-code: TOKEN_REVOKED），axios 因此不會 throw。必須主動檢查這兩個 header，
   * 否則「未回傳 access_token」會掩蓋掉「refresh_token 已被撤銷」的真實原因。
   *
   * @param {Object} response - axios 回應
   * @returns {{code: string|null, revoked: boolean, data: Object|null}} 解析結果
   */
  _parseRefreshResponse(response) {
    const code = response.headers?.["x-error-code"] || null;
    const actual = Number(response.headers?.["x-actual-status-code"] || 200);
    const revoked = code === "TOKEN_REVOKED" || actual === 401;
    return {
      code,
      revoked,
      data: response.data?.data ?? null,
    };
  }

  /**
   * 用 httpOnly refresh_token cookie 換取新的 access token
   *
   * Qwen 前端實際行為：GET /api/v2/auths/refresh，無 body、無特殊 header，
   * 僅靠 cookie 認證，成功回 { data: { access_token, refresh_token } }。
   *
   * 失敗會在 account 上留下診斷標記，供冷卻/告警判斷（避免每個請求重打）：
   *   account.tokenError = { code, revoked, at }
   *
   * @param {Object} account - 帳戶物件，需含 cookies.refresh_token
   * @returns {Promise<string|null>} access token 或 null
   */
  async refreshViaCookie(account) {
    if (!account || !account.cookies || !account.cookies.refresh_token) {
      return null;
    }

    const cookieStr = Object.entries(account.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    // 同一帳戶的並行請求共用同一個 refresh Promise（等待結果，而非回 null）。
    // 用布林鎖會讓併發請求誤判為「取不到 token」而失敗；
    // 用共享 Promise 則全部拿到同一份結果，也避免輪替互相覆蓋。
    if (account._refreshPromise) {
      return account._refreshPromise;
    }

    const run = this._doCookieRefresh(account, cookieStr);
    account._refreshPromise = run;
    // 同步清除，避免 unhandled rejection（失敗值由呼叫端 await 取得）
    run.catch(() => {});
    try {
      return await run;
    } finally {
      account._refreshPromise = null;
    }
  }

  /**
   * 實際執行 cookie refresh（由 refreshViaCookie 呼叫，不應直接使用）
   * @param {Object} account - 帳戶物件
   * @param {string} cookieStr - 序列化 cookie 標頭
   * @returns {Promise<string|null>} access token 或 null
   * @private
   */
  async _doCookieRefresh(account, cookieStr) {
    try {
      const response = await axios.get(this.refreshEndpoint, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Cookie: cookieStr,
          Origin: "https://chat.qwen.ai",
          Referer: "https://chat.qwen.ai/",
          // Qwen 前端會帶這組自訂 header，缺任何一個都會回 400 Bad_Request
          //   Timezone          → new Date().toString() 前 33 字元（例：Mon Oct 05 2026 02:05:03 GMT+0800）
          //   Version           → 前端版本號
          //   source            → 固定 "web"
          //   x-request-origin  → 固定 "https://chat.qwen.ai"
          //   X-Request-Id      → 每次請求唯一 UUID
          Timezone: new Date().toString().slice(0, 33),
          Version: "0.3.12",
          source: "web",
          "x-request-origin": "https://chat.qwen.ai",
          "X-Request-Id": require("crypto").randomUUID(),
          "User-Agent": this.defaultHeaders["User-Agent"],
        },
        timeout: 15000,
      });

      const { code, revoked, data } = this._parseRefreshResponse(response);

      if (revoked) {
        // 撤銷是永久性的，重試無意義：必須重新登入才能取得新 refresh_token
        account.tokenError = {
          code: code || "TOKEN_REVOKED",
          revoked: true,
          at: Date.now(),
        };
        account.token = null;
        account.expires = 0;
        logger.error(
          `refresh_token 已被 Qwen 撤銷，須重新登入取得新 cookie: ${account.email}` +
            `（請執行 node auto-get-token.js 或 seed-profile.mjs）`,
          "TOKEN",
        );
        await this._persist(account.email, { token: null, expires: 0 });
        return null;
      }

      const accessToken = data?.access_token;
      if (!accessToken) {
        account.tokenError = {
          code: code || "NO_ACCESS_TOKEN",
          revoked: false,
          at: Date.now(),
        };
        logger.error(
          `Cookie refresh 未回傳 access_token: ${account.email}` +
            (code ? ` (code=${code})` : ""),
          "TOKEN",
        );
        return null;
      }

      account.tokenError = null;

      // refresh_token 會輪替，必須更新並落盤，否則重啟後舊 token 已被撤銷
      const patch = { token: accessToken };
      const newRefresh = data?.refresh_token;
      if (newRefresh) {
        account.cookies.refresh_token = newRefresh;
        patch.cookies = account.cookies;
        const decodedRefresh = this.validateToken(newRefresh);
        if (decodedRefresh) {
          account.refresh_token_expires = decodedRefresh.exp;
          patch.refresh_token_expires = decodedRefresh.exp;
        }
      }

      account.token = accessToken;
      const decoded = this.validateToken(accessToken);
      if (decoded) {
        account.expires = decoded.exp;
        patch.expires = decoded.exp;
      }

      await this._persist(account.email, patch);

      const mins = Math.max(
        0,
        Math.round(((decoded?.exp ?? 0) * 1000 - Date.now()) / 60000),
      );
      logger.success(
        `Cookie 刷新令牌成功: ${account.email} (有效期: ${mins}分鐘)`,
        "TOKEN",
      );

      return accessToken;
    } catch (error) {
      account.tokenError = {
        code: error.response?.status ?? error.code ?? "NETWORK",
        revoked: false,
        at: Date.now(),
      };
      if (error.response) {
        logger.error(
          `Cookie 刷新失敗 (${error.response.status}): ${account.email}`,
          "TOKEN",
          "",
          error,
        );
      } else {
        logger.error(`Cookie 刷新失敗: ${account.email}`, "TOKEN", "", error);
      }
      return null;
    }
  }

  /**
   * 取得帳戶的可用 access token，必要時自動刷新
   *
   * 流程：
   *  1. token 仍有效 → 直接回傳
   *  2. browser 模式 → cookie refresh（失敗即止，不降級密碼登入）
   *  3. 非 browser 模式且有 email/password → 密碼登入
   *
   * 為何 browser 模式不降級密碼登入：Qwen 已全面拒絕社群帳號的
   * email/password signin（一律 400 Bad_Request），每次降級只會多打一次
   * 無效請求並在日誌噴錯誤。改為直接回 null 讓呼叫端走冷卻/降級路徑。
   *
   * @param {Object} account - 帳戶物件
   * @returns {Promise<string|null>} access token 或 null
   */
  async ensureFreshToken(account) {
    if (!account) return null;

    // 1. 現有 token 還有效（>5 分鐘緩衝）
    if (account.token && this.validateToken(account.token)) {
      const remaining = this.getTokenRemainingHours(account.token) * 60;
      if (remaining > 5) {
        return account.token;
      }
    }

    const isBrowserMode =
      account.loginMethod === "browser" || !!account.cookies?.refresh_token;

    // 2. browser 模式：cookie refresh（唯一合法來源）
    if (isBrowserMode) {
      return this.refreshViaCookie(account);
    }

    // 3. 非 browser 模式才嘗試密碼登入
    if (account.email && account.password) {
      return await this.refreshToken(account)?.then((a) => a?.token || null);
    }

    return null;
  }

  /**
   * 延遲函式
   * @param {number} ms - 延遲毫秒數
   * @private
   */
  async _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = TokenManager;
