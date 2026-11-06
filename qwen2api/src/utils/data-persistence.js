const fs = require("fs").promises;
const path = require("path");
const config = require("../config/index.js");
const redisClient = require("./redis");
const { logger } = require("./logger");

/**
 * 資料持久化管理器
 * 統一處理帳戶資料的存儲和讀取
 */
// Debounce 窗口（per-email）寫入 stats——避免每次 token 累計都觸發檔案 I/O
const STATS_PERSIST_DEBOUNCE_MS = 5000;

class DataPersistence {
  constructor() {
    this.dataFilePath = path.join(__dirname, "../../data/data.json");
    // 每個 email 的待持久化 stats 與定時器（debounce）
    this._statsPersistTimers = new Map();
    this._statsPendingPayload = new Map();
  }

  /**
   * 載入所有帳戶資料
   * @returns {Promise<Array>} 帳戶列表
   */
  async loadAccounts() {
    try {
      switch (config.dataSaveMode) {
        case "redis":
          return await this._loadFromRedis();
        case "file":
          return await this._loadFromFile();
        case "none":
          return await this._loadFromEnv();
        default:
          logger.error(`不支援的資料保存模式: ${config.dataSaveMode}`, "DATA");
          throw new Error(`不支援的資料保存模式: ${config.dataSaveMode}`);
      }
    } catch (error) {
      logger.error("載入帳戶資料失敗", "DATA", "", error);
      throw error;
    }
  }

  /**
   * 保存單個帳戶資料
   * @param {string} email - 郵箱
   * @param {Object} accountData - 帳戶資料
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAccount(email, accountData) {
    try {
      switch (config.dataSaveMode) {
        case "redis":
          return await this._saveToRedis(email, accountData);
        case "file":
          return await this._saveToFile(email, accountData);
        case "none":
          logger.warn("環境變量模式不支援保存帳戶資料", "DATA");
          return false;
        default:
          logger.error(`不支援的資料保存模式: ${config.dataSaveMode}`, "DATA");
          throw new Error(`不支援的資料保存模式: ${config.dataSaveMode}`);
      }
    } catch (error) {
      logger.error(`保存帳戶資料失敗 (${email})`, "DATA", "", error);
      return false;
    }
  }

  /**
   * 載入執行時設定（chat retry config 等）
   * 在 'none' 模式下回傳 {}, 因為沒有可寫存儲
   * @returns {Promise<Object>} 設定物件 (空物件表示尚未存儲任何值)
   */
  async loadSettings() {
    try {
      switch (config.dataSaveMode) {
        case "redis":
          return (await redisClient.getSettings()) || {};
        case "file":
          return await this._loadSettingsFromFile();
        case "none":
          return {};
        default:
          logger.error(`不支援的資料保存模式: ${config.dataSaveMode}`, "DATA");
          return {};
      }
    } catch (error) {
      logger.error("載入執行時設定失敗", "DATA", "", error);
      return {};
    }
  }

  /**
   * 保存執行時設定（部分合併）
   * @param {Object} partial - 要寫入的字段
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveSettings(partial) {
    try {
      switch (config.dataSaveMode) {
        case "redis":
          return await redisClient.setSettings(partial);
        case "file":
          return await this._saveSettingsToFile(partial);
        case "none":
          logger.warn("環境變量模式不支援保存執行時設定", "DATA");
          return false;
        default:
          logger.error(`不支援的資料保存模式: ${config.dataSaveMode}`, "DATA");
          return false;
      }
    } catch (error) {
      logger.error("保存執行時設定失敗", "DATA", "", error);
      return false;
    }
  }

  async _loadSettingsFromFile() {
    await this._ensureDataFileExists();
    const fileContent = await fs.readFile(this.dataFilePath, "utf-8");
    const data = JSON.parse(fileContent);
    return data.settings && typeof data.settings === "object"
      ? data.settings
      : {};
  }

  async _saveSettingsToFile(partial) {
    await this._ensureDataFileExists();
    const fileContent = await fs.readFile(this.dataFilePath, "utf-8");
    const data = JSON.parse(fileContent);
    data.settings = { ...(data.settings || {}), ...partial };
    await fs.writeFile(
      this.dataFilePath,
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    return true;
  }

  /**
   * 批量保存帳戶資料
   * @param {Array} accounts - 帳戶列表
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAllAccounts(accounts) {
    try {
      switch (config.dataSaveMode) {
        case "redis":
          return await this._saveAllToRedis(accounts);
        case "file":
          return await this._saveAllToFile(accounts);
        case "none":
          logger.warn("環境變量模式不支援保存帳戶資料", "DATA");
          return false;
        default:
          logger.error(`不支援的資料保存模式: ${config.dataSaveMode}`, "DATA");
          throw new Error(`不支援的資料保存模式: ${config.dataSaveMode}`);
      }
    } catch (error) {
      logger.error("批量保存帳戶資料失敗", "DATA", "", error);
      return false;
    }
  }

  /**
   * 從 Redis 載入帳戶資料
   * @private
   */
  async _loadFromRedis() {
    const accounts = await redisClient.getAllAccounts();
    return accounts.length > 0 ? accounts : [];
  }

  /**
   * 從檔案載入帳戶資料
   * @private
   */
  async _loadFromFile() {
    // 確保檔案存在
    await this._ensureDataFileExists();

    const fileContent = await fs.readFile(this.dataFilePath, "utf-8");
    const data = JSON.parse(fileContent);

    return data.accounts || [];
  }

  /**
   * 從環境變量載入帳戶資料
   * @private
   */
  async _loadFromEnv() {
    if (!process.env.ACCOUNTS) {
      return [];
    }

    const { parseAccountLine } = require("./account-parser");
    const accountTokens = process.env.ACCOUNTS.split(",");
    const accounts = [];

    // 解析委託給共用 parser，與後臺批量新增保持一致；
    // 注意：這裡僅載入憑據，token 在 Account 類中按需登入取得
    for (const item of accountTokens) {
      const parsed = parseAccountLine(item);
      if (parsed) {
        accounts.push({ ...parsed, token: null, expires: null });
      }
    }

    return accounts;
  }

  /**
   * 保存到 Redis
   * @private
   */
  async _saveToRedis(email, accountData) {
    return await redisClient.setAccount(email, accountData);
  }

  /**
   * 保存到檔案（MERGE 語義）
   * partial save（僅 token、proxy、stats）不應覆蓋未傳字段——保留 existing 值
   * @private
   */
  async _saveToFile(email, accountData) {
    await this._ensureDataFileExists();

    const fileContent = await fs.readFile(this.dataFilePath, "utf-8");
    const data = JSON.parse(fileContent);

    if (!data.accounts) {
      data.accounts = [];
    }

    const existingIndex = data.accounts.findIndex(
      (account) => account.email === email,
    );
    const existing = existingIndex !== -1 ? data.accounts[existingIndex] : {};

    // 僅寫入顯式傳入的字段；未傳字段保留 existing 值。stats 同理——
    // 避免 token refresh / proxy update 的 partial save 把累計 stats 清零
    const merged = { ...existing, email };
    if (accountData.password !== undefined)
      merged.password = accountData.password;
    if (accountData.token !== undefined) merged.token = accountData.token;
    if (accountData.expires !== undefined) merged.expires = accountData.expires;
    if (accountData.proxy !== undefined)
      merged.proxy = accountData.proxy ?? null;
    if (accountData.stats !== undefined) merged.stats = accountData.stats;
    if (accountData.statsHistory !== undefined)
      merged.statsHistory = accountData.statsHistory;
    if (accountData.cli_unavailable_reason !== undefined)
      merged.cli_unavailable_reason = accountData.cli_unavailable_reason;
    // browser 模式認證資料必須落盤：refresh_token 每次 refresh 都會輪替，
    // 不寫回檔案的話重啟後舊 refresh_token 已被 Qwen 撤銷 → TOKEN_REVOKED
    if (accountData.cookies !== undefined) merged.cookies = accountData.cookies;
    if (accountData.refresh_token !== undefined)
      merged.refresh_token = accountData.refresh_token;
    if (accountData.refresh_token_expires !== undefined)
      merged.refresh_token_expires = accountData.refresh_token_expires;
    if (accountData.loginMethod !== undefined)
      merged.loginMethod = accountData.loginMethod;

    if (existingIndex !== -1) {
      data.accounts[existingIndex] = merged;
    } else {
      data.accounts.push(merged);
    }

    await fs.writeFile(
      this.dataFilePath,
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    return true;
  }

  /**
   * 批量保存到 Redis
   * @private
   */
  async _saveAllToRedis(accounts) {
    let successCount = 0;
    for (const account of accounts) {
      const success = await this._saveToRedis(account.email, account);
      if (success) successCount++;
    }
    return successCount === accounts.length;
  }

  /**
   * 批量保存到檔案
   *
   * 合併語義：只覆蓋明確提供的欄位，保留 existing 的 cookies/loginMethod。
   * 早期版本整筆重建 accounts 陣列，導致 browser 帳戶的 cookies 在每日
   * 歸檔（saveAllAccounts）時被整片抹除，重啟後只剩過期 refresh_token。
   * @private
   */
  async _saveAllToFile(accounts) {
    await this._ensureDataFileExists();

    const fileContent = await fs.readFile(this.dataFilePath, "utf-8");
    const data = JSON.parse(fileContent);

    const byEmail = new Map((data.accounts || []).map((a) => [a.email, a]));

    const pick = (account, existing) => {
      const merged = { ...existing };
      const assign = (key, value) => {
        if (value !== undefined) merged[key] = value;
      };
      assign("email", account.email);
      assign("password", account.password);
      assign("token", account.token);
      assign("expires", account.expires);
      assign("proxy", account.proxy ?? null);
      assign("stats", account.stats);
      assign("statsHistory", account.statsHistory);
      assign("cli_unavailable_reason", account.cli_unavailable_reason);
      assign("cookies", account.cookies);
      assign("refresh_token", account.refresh_token);
      assign("refresh_token_expires", account.refresh_token_expires);
      assign("loginMethod", account.loginMethod);
      return merged;
    };

    data.accounts = accounts.map((account) =>
      pick(account, byEmail.get(account.email) || {}),
    );

    await fs.writeFile(
      this.dataFilePath,
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    return true;
  }

  /**
   * 調度 per-account daily stats 持久化（debounce 5 秒）
   * 高頻 accumulateStats 調用合併為單次 I/O——重複調用替換上一個 timer
   * dataSaveMode='none' 時不寫盤，回傳 false
   * @param {string} email - 郵箱
   * @param {Object} stats - 完整 stats 物件 { chat: {input,output}, cli: {calls,input,output} }
   * @returns {boolean} 是否調度成功
   */
  saveAccountStats(email, stats) {
    if (config.dataSaveMode === "none") {
      return false;
    }
    if (!email || !stats) {
      return false;
    }

    // 替換 pending payload 與 timer
    this._statsPendingPayload.set(email, stats);
    const prev = this._statsPersistTimers.get(email);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(async () => {
      this._statsPersistTimers.delete(email);
      const payload = this._statsPendingPayload.get(email);
      this._statsPendingPayload.delete(email);
      if (!payload) return;
      try {
        await this.saveAccount(email, { stats: payload });
      } catch (error) {
        logger.error(`stats 持久化失敗 (${email})`, "STATS", "", error);
      }
    }, STATS_PERSIST_DEBOUNCE_MS);

    this._statsPersistTimers.set(email, timer);
    return true;
  }

  /**
   * 確保資料檔案存在
   * @private
   */
  async _ensureDataFileExists() {
    try {
      await fs.access(this.dataFilePath);
    } catch (error) {
      logger.info("資料檔案不存在，正在創建預設檔案...", "FILE", "📁");

      // 確保目錄存在
      const dirPath = path.dirname(this.dataFilePath);
      await fs.mkdir(dirPath, { recursive: true });

      // 創建預設資料結構
      const defaultData = {
        defaultHeaders: null,
        defaultCookie: null,
        accounts: [],
      };

      await fs.writeFile(
        this.dataFilePath,
        JSON.stringify(defaultData, null, 2),
        "utf-8",
      );
      logger.success("預設資料檔案創建成功", "FILE");
    }
  }
}

module.exports = DataPersistence;
