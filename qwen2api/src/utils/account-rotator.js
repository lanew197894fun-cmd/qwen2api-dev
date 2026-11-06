const { logger } = require("./logger");

/**
 * 帳戶輪詢管理器
 * 負責帳戶的輪詢選擇和負載均衡
 */
class AccountRotator {
  constructor() {
    this.accounts = [];
    this.currentIndex = 0;
    this.lastUsedTimes = new Map(); // 記錄每個帳戶的最後使用時間
    this.failureCounts = new Map(); // 記錄每個帳戶的失敗次數（僅傳輸層失敗累積，觸發 cooldown）
    this.lastErrorAt = new Map(); // 最近一次錯誤的時間戳（用於 UI warn 指示，含 HTTP 4xx/5xx）
    this.lastErrorCode = new Map(); // 最近一次錯誤碼（HTTP status 或 transport err.code）
    this.cooldownStartedAt = new Map(); // 進入 cooldown 的起始時間戳（failureCounts 達閾值時刻）
    this.maxFailures = 3; // 最大失敗次數
    this.cooldownPeriod = 5 * 60 * 1000; // 5分鐘冷卻期
  }

  /**
   * 設定帳戶列表
   * @param {Array} accounts - 帳戶列表
   */
  setAccounts(accounts) {
    if (!Array.isArray(accounts)) {
      logger.error("帳戶列表必須是陣列", "ACCOUNT");
      throw new Error("帳戶列表必須是陣列");
    }

    this.accounts = [...accounts];
    this.currentIndex = 0;

    // 清理不存在帳戶的記錄
    this._cleanupRecords();
  }

  /**
   * 取得下一個可用的帳戶物件
   * @returns {Object|null} 帳戶物件或 null
   */
  getNextAccount() {
    if (this.accounts.length === 0) {
      logger.error("沒有可用的帳戶", "ACCOUNT");
      return null;
    }

    const availableAccounts = this._getAvailableAccounts();
    if (availableAccounts.length === 0) {
      logger.warn("所有帳戶都不可用，使用輪詢策略", "ACCOUNT");
      return this._getAccountByRoundRobin();
    }

    // 從可用帳戶中選擇最少使用的
    const selectedAccount = this._selectLeastUsedAccount(availableAccounts);
    this._recordUsage(selectedAccount.email);

    return selectedAccount;
  }

  /**
   * 取得下一個可用的帳戶令牌（向後相容的便捷方法）
   * @returns {string|null} 帳戶令牌或null
   */
  getNextToken() {
    const account = this.getNextAccount();
    return account ? account.token : null;
  }

  /**
   * 根據郵箱取得帳戶物件
   * @param {string} email - 郵箱地址
   * @returns {Object|null} 帳戶物件或 null
   */
  getAccountByEmail(email) {
    const account = this.accounts.find((acc) => acc.email === email);
    if (!account) {
      logger.error(`未找到郵箱為 ${email} 的帳戶`, "ACCOUNT");
      return null;
    }

    if (!this._isAccountAvailable(account)) {
      logger.warn(`帳戶 ${email} 目前不可用`, "ACCOUNT");
      return null;
    }

    this._recordUsage(email);
    return account;
  }

  /**
   * 取得指定郵箱的帳戶令牌（向後相容的便捷方法）
   * @param {string} email - 郵箱地址
   * @returns {string|null} 帳戶令牌或null
   */
  getTokenByEmail(email) {
    const account = this.getAccountByEmail(email);
    return account ? account.token : null;
  }

  /**
   * 記錄帳戶傳輸層失敗（影響 cooldown）
   * 僅在傳輸層錯誤（timeout/ECONNRESET 等）調用——HTTP 4xx/5xx 走 recordError
   * @param {string} email - 郵箱地址
   * @param {string|number} [code] - 錯誤碼（err.code 或 HTTP status），用於 UI warn
   */
  recordFailure(email, code) {
    const currentFailures = this.failureCounts.get(email) || 0;
    const nextFailures = currentFailures + 1;
    this.failureCounts.set(email, nextFailures);

    // 同時填充 warn 指示狀態（recordFailure 是 recordError 的超集）
    this.lastErrorAt.set(email, Date.now());
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code);
    }

    // 達到閾值的瞬間標記 cooldown 起點（獨立於 lastUsedTimes，CLI-only 失敗也正確）
    if (
      nextFailures >= this.maxFailures &&
      !this.cooldownStartedAt.has(email)
    ) {
      this.cooldownStartedAt.set(email, Date.now());
      logger.warn(`帳戶 ${email} 失敗次數達到上限，將進入冷卻期`, "ACCOUNT");
    }
  }

  /**
   * 記錄帳戶錯誤（僅用於 UI warn 指示，不影響 cooldown）
   * HTTP 4xx/5xx 走這裡——上游主動拒絕，帳戶本身有效，不應進入 cooldown
   * @param {string} email - 郵箱地址
   * @param {string|number} [code] - HTTP status 或錯誤碼
   */
  recordError(email, code) {
    this.lastErrorAt.set(email, Date.now());
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code);
    }
  }

  /**
   * 重置帳戶失敗計數（清除 cooldown）
   * 注意：不清理 lastErrorAt/lastErrorCode——它們由 endpoint 的 15 分鐘窗口管理
   * @param {string} email - 郵箱地址
   */
  resetFailures(email) {
    this.failureCounts.delete(email);
    this.cooldownStartedAt.delete(email);
  }

  /**
   * 取得帳戶統計資訊
   * @returns {Object} 統計資訊
   */
  getStats() {
    const total = this.accounts.length;
    const available = this._getAvailableAccounts().length;
    const inCooldown = total - available;

    const usageStats = {};
    this.accounts.forEach((account) => {
      const email = account.email;
      const cooldownStart = this.cooldownStartedAt.get(email);
      usageStats[email] = {
        failures: this.failureCounts.get(email) || 0,
        lastUsed: this.lastUsedTimes.get(email) || null,
        available: this._isAccountAvailable(account),
        lastErrorAt: this.lastErrorAt.get(email) || null,
        lastErrorCode: this.lastErrorCode.get(email) || null,
        // 認證失敗診斷：refresh_token 遭撤銷時前端應提示「需重新登入」
        tokenError: account.tokenError
          ? {
              code: account.tokenError.code,
              revoked: !!account.tokenError.revoked,
              at: account.tokenError.at,
            }
          : null,
        cooldownEndsAt: cooldownStart
          ? cooldownStart + this.cooldownPeriod
          : null,
      };
    });

    return {
      total,
      available,
      inCooldown,
      currentIndex: this.currentIndex,
      usageStats,
    };
  }

  /**
   * 取得可用帳戶列表
   * @private
   */
  _getAvailableAccounts() {
    return this.accounts.filter((account) => this._isAccountAvailable(account));
  }

  /**
   * 檢查帳戶是否可用
   * @param {Object} account - 帳戶物件
   * @returns {boolean} 是否可用
   * @private
   */
  _isAccountAvailable(account) {
    // Fix 2026-10-05: browser 模式帳戶（loginMethod=browser / 有 refresh_token cookie）
    // 沒有預存 access token —— token 是每次請求前透過 cookie refresh 取得。
    // 舊邏輯要求 account.token 存在，會把這些帳戶全部判為不可用。
    const hasBrowserSession =
      account.loginMethod === "browser" || !!account.cookies?.refresh_token;
    if (!account.token && !hasBrowserSession) {
      return false;
    }

    // refresh_token 被 Qwen 撤銷 → 重新登入前無法取得任何 access token。
    // 標為不可用，避免被選中後才在請求路徑失敗（並引發無謂的 refresh 風暴）。
    if (account.tokenError?.revoked) {
      return false;
    }

    // 基於 cooldownStartedAt（顯式標記）而非 lastUsedTimes——
    // 後者對 CLI-only 失敗不更新，導致 cooldown 計算不準
    const cooldownStart = this.cooldownStartedAt.get(account.email);
    if (cooldownStart) {
      if (Date.now() - cooldownStart < this.cooldownPeriod) {
        return false; // 仍在冷卻期
      }
      // 冷卻期結束，清理 cooldown 標記與失敗計數（lastError* 不動，由 endpoint 管理 warn 窗口）
      this.cooldownStartedAt.delete(account.email);
      this.failureCounts.delete(account.email);
    }

    return true;
  }

  /**
   * 選擇最少使用的帳戶
   * @param {Array} accounts - 可用帳戶列表
   * @returns {Object} 選中的帳戶
   * @private
   */
  _selectLeastUsedAccount(accounts) {
    if (accounts.length === 1) {
      return accounts[0];
    }

    // 按最後使用時間排序，選擇最久未使用的
    return accounts.reduce((least, current) => {
      const leastLastUsed = this.lastUsedTimes.get(least.email) || 0;
      const currentLastUsed = this.lastUsedTimes.get(current.email) || 0;

      return currentLastUsed < leastLastUsed ? current : least;
    });
  }

  /**
   * 輪詢策略取得帳戶物件
   * @returns {Object|null} 帳戶物件或null
   * @private
   */
  _getAccountByRoundRobin() {
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = 0;
    }

    const account = this.accounts[this.currentIndex];
    this.currentIndex++;

    if (
      account &&
      (account.token ||
        account.loginMethod === "browser" ||
        !!account.cookies?.refresh_token)
    ) {
      this._recordUsage(account.email);
      return account;
    }

    // 如果目前帳戶無效，嘗試下一個
    if (this.currentIndex < this.accounts.length) {
      return this._getAccountByRoundRobin();
    }

    return null;
  }

  /**
   * 記錄帳戶使用
   * @param {string} email - 郵箱地址
   * @private
   */
  _recordUsage(email) {
    this.lastUsedTimes.set(email, Date.now());
  }

  /**
   * 清理不存在帳戶的記錄
   * @private
   */
  _cleanupRecords() {
    const currentEmails = new Set(this.accounts.map((acc) => acc.email));

    const maps = [
      this.failureCounts,
      this.lastUsedTimes,
      this.lastErrorAt,
      this.lastErrorCode,
      this.cooldownStartedAt,
    ];
    for (const map of maps) {
      for (const email of map.keys()) {
        if (!currentEmails.has(email)) {
          map.delete(email);
        }
      }
    }
  }

  /**
   * 重置所有統計資料
   */
  reset() {
    this.currentIndex = 0;
    this.lastUsedTimes.clear();
    this.failureCounts.clear();
    this.lastErrorAt.clear();
    this.lastErrorCode.clear();
    this.cooldownStartedAt.clear();
  }
}

module.exports = AccountRotator;
