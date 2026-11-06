const config = require("../config/index.js");
const DataPersistence = require("./data-persistence");
const TokenManager = require("./token-manager");
const AccountRotator = require("./account-rotator");
const { logger } = require("./logger");

/**
 * 預設 daily stats 結構。回傳新物件，調用方安全修改
 * @returns {Object} default stats
 */
const createDefaultStats = () => ({
  chat: { input: 0, output: 0 },
  cli: { calls: 0, input: 0, output: 0 },
});

/**
 * 保證帳戶具備 stats 和 statsHistory 字段（相容老 data.json/Redis 資料）
 * @param {Object} account - 帳戶物件
 */
const ensureStats = (account) => {
  if (!account) return;
  if (!account.stats || typeof account.stats !== "object") {
    account.stats = createDefaultStats();
  } else {
    if (!account.stats.chat || typeof account.stats.chat !== "object") {
      account.stats.chat = { input: 0, output: 0 };
    } else {
      account.stats.chat.input = Number(account.stats.chat.input) || 0;
      account.stats.chat.output = Number(account.stats.chat.output) || 0;
    }
    if (!account.stats.cli || typeof account.stats.cli !== "object") {
      account.stats.cli = { calls: 0, input: 0, output: 0 };
    } else {
      account.stats.cli.calls = Number(account.stats.cli.calls) || 0;
      account.stats.cli.input = Number(account.stats.cli.input) || 0;
      account.stats.cli.output = Number(account.stats.cli.output) || 0;
    }
  }
  // statsHistory: { 'YYYY-MM-DD': { chat:{input,output}, cli:{calls,input,output} } }
  // Backward-compat: legacy records without the field — initialize to {}
  if (!account.statsHistory || typeof account.statsHistory !== "object") {
    account.statsHistory = {};
  }
};

/**
 * YYYY-MM-DD date key for (now + offsetDays) in Node process local TZ
 * @param {number} offsetDays - day offset (negative = past)
 * @returns {string}
 */
const _formatDateKey = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const _getTodayKey = () => _formatDateKey(0);
const _getYesterdayKey = () => _formatDateKey(-1);
const _dateKeyDaysAgo = (n) => _formatDateKey(-n);

const _hasNonZeroStats = (stats) => {
  if (!stats || typeof stats !== "object") return false;
  const c = stats.chat || {};
  const l = stats.cli || {};
  return (
    (Number(c.input) || 0) > 0 ||
    (Number(c.output) || 0) > 0 ||
    (Number(l.calls) || 0) > 0 ||
    (Number(l.input) || 0) > 0 ||
    (Number(l.output) || 0) > 0
  );
};

const STATS_HISTORY_RETENTION_DAYS = 90;

/**
 * refresh_token 被 Qwen 撤銷後的重試冷卻時間
 * 撤銷需重新登入才能修復，重試只會產生無效請求與日誌洪水
 */
const REVOKED_RETRY_COOLDOWN = 30 * 60 * 1000;
/**
 * 帳戶管理器
 * 統一管理帳戶、令牌、模型等功能
 */
class Account {
  constructor() {
    // 初始化各個管理器
    this.dataPersistence = new DataPersistence();
    this.tokenManager = new TokenManager();
    this.accountRotator = new AccountRotator();

    // 帳戶資料
    this.accountTokens = [];
    this.isInitialized = false;

    // 配置資訊
    this.defaultHeaders = config.defaultHeaders || {};

    // cli請求次數定時重新整理器
    this.cliRequestNumberInterval = null;
    this.cliDailyResetInterval = null;

    // Keep the init promise so debug methods can await readiness
    this._initPromise = this._initialize();
  }

  /**
   * 綁定 TokenManager 的持久化回呼
   * refresh_token 每次刷新都會輪替，必須即時落盤，
   * 否則重啟後 data.json 仍是舊 refresh_token → TOKEN_REVOKED
   * @private
   */
  _bindTokenPersist() {
    this.tokenManager.persistHook = async (email, patch) => {
      const acc = this.accountTokens.find((a) => a.email === email);
      if (acc) {
        if (patch.cookies !== undefined) acc.cookies = patch.cookies;
        if (patch.token !== undefined) acc.token = patch.token;
        if (patch.expires !== undefined) acc.expires = patch.expires;
        if (patch.refresh_token_expires !== undefined) {
          acc.refresh_token_expires = patch.refresh_token_expires;
        }
      }
      // 同步頂層 refresh_token 欄位（舊格式相容，避免下次載入時過期）
      const payload = { ...patch };
      if (patch.refresh_token !== undefined) {
        payload.refresh_token = patch.refresh_token;
      } else if (patch.cookies?.refresh_token) {
        payload.refresh_token = patch.cookies.refresh_token;
      }
      return this.dataPersistence.saveAccount(email, payload);
    };
  }

  /**
   * 非同步初始化
   * @private
   */
  async _initialize() {
    try {
      this._bindTokenPersist();

      // 載入帳戶資訊
      await this.loadAccountTokens();

      // 設定定期重新整理令牌
      if (config.autoRefresh) {
        this.refreshInterval = setInterval(
          () => this.autoRefreshTokens(),
          (config.autoRefreshInterval || 21600) * 1000, // 預設6小時
        );
      }

      this.isInitialized = true;
      logger.success(
        `帳戶管理器初始化完成，共載入 ${this.accountTokens.length} 個帳戶`,
        "ACCOUNT",
      );

      // Fix 2026-10-05: browser 模式帳戶的 access token 效期僅約 15 分鐘，
      // 啟動後立即補一次 token，讓 account.token 一開始就有值
      //（後續由 _ensureTokenAsync 於請求前背景維護）。
      this._primeBrowserTokens();
    } catch (error) {
      this.isInitialized = false;
      logger.error("帳戶管理器初始化失敗", "ACCOUNT", "", error);
    }
  }

  /**
   * 載入帳戶令牌資料
   * @returns {Promise<void>}
   */
  async loadAccountTokens() {
    try {
      this.accountTokens = await this.dataPersistence.loadAccounts();

      // 相容歷史資料：舊 data.json/Redis 沒有 stats 字段
      this.accountTokens.forEach(ensureStats);

      // 如果是環境變量模式，需要進行登入取得令牌
      if (config.dataSaveMode === "none" && this.accountTokens.length > 0) {
        await this._loginEnvironmentAccounts();
      }

      // 驗證和清理無效令牌
      await this._validateAndCleanTokens();

      // 更新帳戶輪詢器
      this.accountRotator.setAccounts(this.accountTokens);

      // 初始化 CLI 帳戶（後臺執行，不阻塞 chat-flow init）
      // 為所有帳戶啟動 CLI 初始化，確保沒有 CLI 額度的帳號被正確標記為 unsupported
      if (this.accountTokens.length > 0) {
        logger.info(
          `後臺初始化所有 ${this.accountTokens.length} 個帳戶的 CLI`,
          "ACCOUNT",
        );
        Promise.allSettled(
          this.accountTokens.map((account) =>
            this._initializeCliAccount(account),
          ),
        ).then(() => {
          const cliReady = this.accountTokens.filter((a) => a.cli_info).length;
          const cliUnsupported = this.accountTokens.filter(
            (a) => a.cli_unavailable_reason === "unsupported",
          ).length;
          logger.success(
            `CLI 初始化完成: ${cliReady} 個可用, ${cliUnsupported} 個不支援`,
            "CLI",
          );
        });
      }

      // 設定cli定時器 每天00:00:00重新整理請求次數
      this._setupDailyResetTimer();

      logger.success(`成功載入 ${this.accountTokens.length} 個帳戶`, "ACCOUNT");
    } catch (error) {
      logger.error("載入帳戶令牌失敗", "ACCOUNT", "", error);
      this.accountTokens = [];
      this.accountRotator.setAccounts(this.accountTokens);
      throw error;
    }
  }

  /**
   * 為環境變量模式的帳戶進行登入
   * @private
   */
  async _loginEnvironmentAccounts() {
    const loginPromises = this.accountTokens.map(async (account) => {
      if (!account.token && account.email && account.password) {
        const token = await this.tokenManager.login(
          account.email,
          account.password,
          account,
        );
        if (token) {
          const decoded = this.tokenManager.validateToken(token);
          if (decoded) {
            account.token = token;
            account.expires = decoded.exp;
          }
        }
      }
      return account;
    });

    this.accountTokens = await Promise.all(loginPromises);
  }

  /**
   * 初始化CLI帳戶
   * @param {Object} account - 帳戶物件
   * @private
   */
  async _initializeCliAccount(account) {
    // 沒密碼的帳號無法做 CLI 登入，直接跳過避免 504
    if (!account || !account.password) {
      account.cli_info = null;
      account.cli_unavailable_reason = "unsupported";
      return;
    }
    // 已被標記為 CLI 不支援（如 Google 社群帳號無法 OAuth），跳過避免 504
    if (account.cli_unavailable_reason === "unsupported") {
      account.cli_info = null;
      return;
    }
    try {
      const cliManager = require("./cli.manager");
      const cliAccount = await Promise.race([
        cliManager.initCliAccount(account.token, account),
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                status: false,
                access_token: null,
                refresh_token: null,
                expiry_date: null,
              }),
            20000,
          ),
        ),
      ]);

      if (
        cliAccount.access_token &&
        cliAccount.refresh_token &&
        cliAccount.expiry_date
      ) {
        account.cli_unavailable_reason = null;
        account.cli_info = {
          access_token: cliAccount.access_token,
          refresh_token: cliAccount.refresh_token,
          expiry_date: cliAccount.expiry_date,
          refresh_token_interval: setInterval(
            async () => {
              try {
                const refreshToken = await cliManager.refreshAccessToken(
                  {
                    access_token: account.cli_info.access_token,
                    refresh_token: account.cli_info.refresh_token,
                    expiry_date: account.cli_info.expiry_date,
                  },
                  account,
                );
                if (
                  refreshToken.access_token &&
                  refreshToken.refresh_token &&
                  refreshToken.expiry_date
                ) {
                  account.cli_info.access_token = refreshToken.access_token;
                  account.cli_info.refresh_token = refreshToken.refresh_token;
                  account.cli_info.expiry_date = refreshToken.expiry_date;
                  logger.info(
                    `CLI帳戶 ${account.email} 令牌重新整理成功`,
                    "CLI",
                  );
                }
              } catch (error) {
                logger.error(
                  `CLI帳戶 ${account.email} 令牌重新整理失敗`,
                  "CLI",
                  "",
                  error,
                );
              }
              // 每2小時重新整理一次
            },
            1000 * 60 * 60 * 2,
          ),
          request_number: 0,
        };
        logger.success(`CLI帳戶 ${account.email} 初始化成功`, "CLI");
      } else {
        account.cli_info = null;
        account.cli_unavailable_reason = "unsupported";
        logger.error(
          `CLI帳戶 ${account.email} 初始化失敗：無效的回應資料`,
          "CLI",
          "",
          cliAccount,
        );
      }
    } catch (error) {
      account.cli_info = null;
      account.cli_unavailable_reason = "unsupported";
      logger.error(`CLI帳戶 ${account.email} 初始化失敗`, "CLI", "", error);
    }
  }

  /**
   * 設定每日重置定時器
   * @private
   */
  _setupDailyResetTimer() {
    logger.info(
      "設定每日 00:00 重置定時器（CLI 請求次數 + daily stats）",
      "CLI",
    );

    // 計算到下一天00:00:00的毫秒數
    const now = new Date();
    const tomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
    );
    const timeDiff = tomorrow.getTime() - now.getTime();

    logger.info(
      `距離下次重置還有 ${Math.round(timeDiff / 1000 / 60)} 分鐘`,
      "CLI",
    );

    // 首次執行使用setTimeout
    this.cliRequestNumberInterval = setTimeout(() => {
      this._resetDailyCounters();

      // 設定每24小時執行一次的定時器
      this.cliDailyResetInterval = setInterval(
        () => {
          this._resetDailyCounters();
        },
        24 * 60 * 60 * 1000,
      );
    }, timeDiff);
  }

  /**
   * Daily 00:00 reset: CLI request counters + chat/cli daily stats.
   * Before zeroing, snapshot yesterday into account.statsHistory and prune
   * entries older than STATS_HISTORY_RETENTION_DAYS days, then a single
   * saveAllAccounts batch (instead of 30 individual saves).
   *
   * Caveats:
   * - PM2_INSTANCES > 1: each worker archives its own partial copy of stats;
   *   the daily total would be under-reported proportionally to the worker
   *   count. With instances=1 (ecosystem.config.js default) this is not
   *   triggered.
   * - DATA_SAVE_MODE=none: saveAllAccounts returns false and history is not
   *   persisted. Set DATA_SAVE_MODE=file or redis to enable the feature.
   * @private
   */
  async _resetDailyCounters() {
    // CLI 請求計數（舊邏輯）
    const cliAccounts = this.accountTokens.filter(
      (account) => account.cli_info,
    );
    cliAccounts.forEach((account) => {
      account.cli_info.request_number = 0;
    });

    const yesterday = _getYesterdayKey();
    const cutoff = _dateKeyDaysAgo(STATS_HISTORY_RETENTION_DAYS);
    let archivedCount = 0;

    // For every account (including inactive ones) prune old history;
    // for accounts with any non-zero counters, snapshot yesterday.
    this.accountTokens.forEach((account) => {
      ensureStats(account);

      // Date-based pruning (string compare is valid for YYYY-MM-DD).
      for (const key of Object.keys(account.statsHistory)) {
        if (key < cutoff) {
          delete account.statsHistory[key];
        }
      }

      // Snapshot only if there was at least one non-zero counter.
      if (_hasNonZeroStats(account.stats)) {
        account.statsHistory[yesterday] = {
          chat: { ...account.stats.chat },
          cli: { ...account.stats.cli },
        };
        archivedCount++;
      }

      // Reset today.
      account.stats.chat.input = 0;
      account.stats.chat.output = 0;
      account.stats.cli.calls = 0;
      account.stats.cli.input = 0;
      account.stats.cli.output = 0;
    });

    logger.info(
      `已重置 ${cliAccounts.length} 個CLI帳戶請求次數 + ${this.accountTokens.length} 個帳戶 daily stats，歸檔 ${archivedCount} 條 statsHistory[${yesterday}]`,
      "CLI",
    );

    // Single batch save. In file mode — one data.json rewrite; in redis
    // mode — sequential HSETs (the saveAccountStats debounce is not used).
    try {
      await this.dataPersistence.saveAllAccounts(this.accountTokens);
    } catch (error) {
      logger.error("每日重置後 persist 失敗", "ACCOUNT", "", error);
    }
  }

  /**
   * Public helper: today's YYYY-MM-DD key in Node process local TZ.
   * Paired with the _getYesterdayKey used inside _resetDailyCounters.
   * The /statsHistory route must use this rather than new Date() in the
   * browser — otherwise differing browser/container TZs can shift month
   * boundaries.
   * @returns {string}
   */
  getTodayKey() {
    return _getTodayKey();
  }

  /**
   * Debug: manual trigger for archive/reset (used by the dev endpoint).
   * The readiness guard prevents wiping data.accounts = [] before init finishes.
   * @returns {Promise<void>}
   */
  async archiveYesterdayForTest() {
    if (this._initPromise) {
      await this._initPromise;
    }
    if (
      !this.isInitialized ||
      !Array.isArray(this.accountTokens) ||
      this.accountTokens.length === 0
    ) {
      throw new Error(
        "account manager not initialized — refusing to archive (would wipe data)",
      );
    }
    return this._resetDailyCounters();
  }

  /**
   * 重置CLI請求次數（向後相容別名）
   * @private
   */
  _resetCliRequestNumbers() {
    return this._resetDailyCounters();
  }

  /**
   * 從本地 cookie 備份恢復 browser 模式帳戶
   *
   * 流程：.qwen-token.json（種子時寫入，含輪替後的 refresh_token）
   *      → 還原 cookies → 驗證 refresh_token → 寫回帳戶
   *
   * @private
   */
  async _recoverBrowserAccount(account) {
    const fs = require("fs");
    const path = require("path");
    const backup = path.join(__dirname, "../../.qwen-token.json");

    if (!fs.existsSync(backup)) {
      logger.error(
        `無 cookie 備份可恢復: ${backup}，需重新執行 seed-profile.mjs`,
        "TOKEN",
      );
      return false;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(backup, "utf-8"));
      const flat = {};
      raw.forEach((c) => (flat[c.name] = c.value));
      const rt = flat.refresh_token;
      if (!rt || !this.tokenManager.validateToken(rt)) {
        logger.error(
          `cookie 備份中的 refresh_token 亦已過期: ${account.email}`,
          "TOKEN",
        );
        return false;
      }

      account.cookies = flat;
      account.refresh_token_expires = this.tokenManager.validateToken(rt).exp;
      logger.success(
        `已從 cookie 備份恢復 browser 帳戶: ${account.email}`,
        "TOKEN",
      );
      await this.dataPersistence.saveAccount(account.email, {
        cookies: account.cookies,
        refresh_token: rt,
        refresh_token_expires: account.refresh_token_expires,
      });
      return true;
    } catch (error) {
      logger.error(`cookie 備份恢復失敗: ${account.email}`, "TOKEN", "", error);
      return false;
    }
  }

  /**
   * 驗證和清理無效令牌
   * @private
   */
  async _validateAndCleanTokens() {
    const validAccounts = [];

    for (const account of this.accountTokens) {
      // Fix 2026-10-05: browser 模式帳戶沒有預存 access token，
      // 只有 refresh_token cookie（效期 30 天）。改版後 email/password 登入
      // 已被 Qwen 全面拒絕（400），若沿用舊的過濾邏輯會把這些帳戶全部清空。
      const isBrowserMode =
        account.loginMethod === "browser" || !!account.cookies?.refresh_token;
      if (isBrowserMode) {
        const decodedRefresh = this.tokenManager.validateToken(
          account.cookies.refresh_token,
        );
        if (decodedRefresh) {
          account.refresh_token_expires = decodedRefresh.exp;
          validAccounts.push(account);
          continue;
        }
        // refresh_token 已過期 → 嘗試從本地 cookie 備份恢復
        logger.warn(
          `refresh_token 已過期: ${account.email}，嘗試從 cookie 備份恢復`,
          "TOKEN",
        );
        const recovered = await this._recoverBrowserAccount(account);
        if (recovered) {
          validAccounts.push(account);
        }
        continue;
      }

      if (account.token && this.tokenManager.validateToken(account.token)) {
        validAccounts.push(account);
      } else if (account.email && account.password) {
        // 嘗試重新登入
        logger.info(`令牌無效，嘗試重新登入: ${account.email}`, "TOKEN", "🔄");
        const newToken = await this.tokenManager.login(
          account.email,
          account.password,
          account,
        );
        if (newToken) {
          const decoded = this.tokenManager.validateToken(newToken);
          if (decoded) {
            account.token = newToken;
            account.expires = decoded.exp;
            validAccounts.push(account);
          }
        }
      }
    }

    this.accountTokens = validAccounts;
  }

  /**
   * 自動重新整理即將過期的令牌
   * @param {number} thresholdHours - 過期閾值（小時）
   * @returns {Promise<number>} 成功重新整理的令牌數量
   */
  async autoRefreshTokens(thresholdHours = 24) {
    if (!this.isInitialized) {
      logger.warn("帳戶管理器尚未初始化，跳過自動重新整理", "TOKEN");
      return 0;
    }

    logger.info("開始自動重新整理令牌...", "TOKEN", "🔄");

    // 取得需要重新整理的帳戶
    const needsRefresh = this.accountTokens.filter((account) =>
      this.tokenManager.isTokenExpiringSoon(account.token, thresholdHours),
    );

    if (needsRefresh.length === 0) {
      logger.info("沒有需要重新整理的令牌", "TOKEN");
      return 0;
    }

    logger.info(`發現 ${needsRefresh.length} 個令牌需要重新整理`, "TOKEN");

    let successCount = 0;
    let failedCount = 0;

    // 逐個重新整理帳戶，每次成功後立即保存
    for (const account of needsRefresh) {
      try {
        const updatedAccount = await this.tokenManager.refreshToken(account);
        if (updatedAccount) {
          // 立即更新內存中的帳戶資料
          const index = this.accountTokens.findIndex(
            (acc) => acc.email === account.email,
          );
          if (index !== -1) {
            this.accountTokens[index] = updatedAccount;
          }

          // 立即保存到持久化存儲
          await this.dataPersistence.saveAccount(account.email, {
            password: updatedAccount.password,
            token: updatedAccount.token,
            expires: updatedAccount.expires,
            proxy: updatedAccount.proxy ?? account.proxy ?? null,
          });

          // 重置失敗計數
          this.accountRotator.resetFailures(account.email);
          successCount++;

          logger.info(
            `帳戶 ${account.email} 令牌重新整理並保存成功 (${successCount}/${needsRefresh.length})`,
            "TOKEN",
            "✅",
          );
        } else {
          // 記錄失敗的帳戶
          this.accountRotator.recordFailure(account.email);
          failedCount++;
          logger.error(
            `帳戶 ${account.email} 令牌重新整理失敗 (${failedCount} 個失敗)`,
            "TOKEN",
            "❌",
          );
        }
      } catch (error) {
        this.accountRotator.recordFailure(account.email);
        failedCount++;
        logger.error(
          `帳戶 ${account.email} 重新整理過程中出錯`,
          "TOKEN",
          "",
          error,
        );
      }

      // 新增延遲避免請求過於頻繁
      await this._delay(1000);
    }

    // 更新輪詢器
    this.accountRotator.setAccounts(this.accountTokens);

    logger.success(
      `令牌重新整理完成: 成功 ${successCount} 個，失敗 ${failedCount} 個`,
      "TOKEN",
    );
    return successCount;
  }

  /**
   * 為所有 browser 模式帳戶立即取得 access token
   *
   * Qwen 改版後 access token 僅約 15 分鐘效期，啟動時必須先 refresh 一次，
   * 否則 account.token 為空，Chrome Fetch / curl-impersonate 等直接讀 token 的
   * 呼叫點會全部失敗。
   *
   * @private
   */
  _primeBrowserTokens() {
    if (!this.tokenManager?.ensureFreshToken) return;

    this.accountTokens
      .filter((a) => a.loginMethod === "browser" || a.cookies?.refresh_token)
      .forEach((account) => {
        this.tokenManager
          .ensureFreshToken(account)
          .then((t) => {
            if (t) {
              logger.info(
                `已備妥 browser 帳戶 token: ${account.email}`,
                "TOKEN",
              );
            }
          })
          .catch(() => {});
      });
  }

  /**
   * 取得下一個可用的帳戶物件（包含 proxy 等完整字段）
   * @returns {Object|null} 帳戶物件或 null
   */
  getAccount() {
    if (!this.isInitialized) {
      logger.warn("帳戶管理器尚未初始化完成", "ACCOUNT");
      return null;
    }

    if (this.accountTokens.length === 0) {
      logger.error("沒有可用的帳戶令牌", "ACCOUNT");
      return null;
    }

    const account = this.accountRotator.getNextAccount();
    if (!account) {
      logger.error("所有帳戶令牌都不可用", "ACCOUNT");
      return null;
    }

    // 背景補上 access token（browser 模式的 token 僅約 15 分鐘有效）
    // 不阻塞本次回傳：同步呼叫端會在送出前再檢查一次 token 是否新鮮
    this._ensureTokenAsync(account);

    return account;
  }

  /**
   * 非阻塞地確保帳戶持有新鮮 access token
   *
   * Qwen 改版後 access token 效期僅約 15 分鐘，必須在使用前刷新。
   * 這裡以 fire-and-forget 方式補 token，避免阻塞輪詢路徑。
   *
   * @private
   */
  _ensureTokenAsync(account) {
    if (!account || !this.tokenManager?.ensureFreshToken) return;
    if (!account.loginMethod && !account.cookies?.refresh_token) return;

    // 撤銷（revoked）為永久狀態：重試無意義，只會每個請求噴一次錯誤。
    // 冷卻 30 分鐘後才允許再試一次（使用者可能已重新登入注入 cookie）。
    const err = account.tokenError;
    if (err?.revoked && Date.now() - (err.at || 0) < REVOKED_RETRY_COOLDOWN) {
      return;
    }

    // token 還新鮮就跳過（避免每個請求都打 refresh）
    if (this.tokenManager.validateToken(account.token)) {
      if (this.tokenManager.getTokenRemainingHours(account.token) * 60 > 5)
        return;
    }

    // 同一帳戶的並行請求只觸發一次 refresh
    if (account._refreshing) return;
    account._refreshing = true;

    this.tokenManager
      .ensureFreshToken(account)
      .catch(() => {})
      .finally(() => {
        account._refreshing = false;
      });
  }

  /**
   * 取得可用的帳戶令牌（向後相容的便捷方法）
   * @returns {string|null} 帳戶令牌或null
   */
  async getAccountToken() {
    const account = this.getAccount();
    if (!account) return null;

    // browser 模式帳戶的 access token 僅約 15 分鐘有效期，
    // 需在每次取用前確保新鮮（過期時用 refresh_token cookie 換取）
    if (this.tokenManager.ensureFreshToken) {
      const fresh = await this.tokenManager.ensureFreshToken(account);
      if (fresh) return fresh;
      logger.error(`帳戶無法取得有效令牌: ${account.email}`, "ACCOUNT");
      return null;
    }

    return account.token || null;
  }

  /**
   * 根據郵箱取得特定帳戶物件
   * @param {string} email - 郵箱地址
   * @returns {Object|null} 帳戶物件或 null
   */
  getAccountByEmail(email) {
    return this.accountRotator.getAccountByEmail(email);
  }

  /**
   * 根據令牌反查帳戶物件（用於只持有 token 的下游調用解析帳號級代理）
   * @param {string} token - 訪問令牌
   * @returns {Object|null} 帳戶物件或 null
   */
  getAccountByToken(token) {
    if (!token) return null;
    return this.accountTokens.find((acc) => acc.token === token) || null;
  }

  /**
   * 根據郵箱取得特定帳戶的令牌（向後相容）
   * @param {string} email - 郵箱地址
   * @returns {string|null} 帳戶令牌或null
   */
  getTokenByEmail(email) {
    return this.accountRotator.getTokenByEmail(email);
  }

  /**
   * 保存更新後的帳戶資料
   * @param {Array} updatedAccounts - 更新後的帳戶列表
   * @private
   */
  async _saveUpdatedAccounts(updatedAccounts) {
    try {
      for (const account of updatedAccounts) {
        await this.dataPersistence.saveAccount(account.email, {
          password: account.password,
          token: account.token,
          expires: account.expires,
          proxy: account.proxy ?? null,
        });
      }
    } catch (error) {
      logger.error("保存更新後的帳戶資料失敗", "ACCOUNT", "", error);
    }
  }

  /**
   * 手動重新整理指定帳戶的令牌
   * @param {string} email - 郵箱地址
   * @returns {Promise<boolean>} 重新整理是否成功
   */
  async refreshAccountToken(email) {
    const account = this.accountTokens.find((acc) => acc.email === email);
    if (!account) {
      logger.error(`未找到郵箱為 ${email} 的帳戶`, "ACCOUNT");
      return false;
    }

    const updatedAccount = await this.tokenManager.refreshToken(account);
    if (updatedAccount) {
      // 更新內存中的資料
      const index = this.accountTokens.findIndex((acc) => acc.email === email);
      if (index !== -1) {
        this.accountTokens[index] = updatedAccount;
      }

      // 保存到持久化存儲
      await this.dataPersistence.saveAccount(email, {
        password: updatedAccount.password,
        token: updatedAccount.token,
        expires: updatedAccount.expires,
        proxy: updatedAccount.proxy ?? account.proxy ?? null,
      });

      // 重置失敗計數
      this.accountRotator.resetFailures(email);

      return true;
    }

    return false;
  }

  // 更新銷燬方法，清除定時器
  destroy() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  /**
   * 產生 Markdown 表格
   * @param {Array} websites - 網站資訊陣列
   * @param {string} mode - 模式 ('table' 或 'text')
   * @returns {Promise<string>} Markdown 字符串
   */
  async generateMarkdownTable(websites, mode) {
    // 輸入校驗
    if (!Array.isArray(websites) || websites.length === 0) {
      return "";
    }

    let markdown = "";
    if (mode === "table") {
      markdown += "| **序號** | **網站URL** | **來源** |\n";
      markdown += "|:---|:---|:---|\n";
    }

    // 預設值
    const DEFAULT_TITLE = "未知標題";
    const DEFAULT_URL = "https://www.baidu.com";
    const DEFAULT_HOSTNAME = "未知來源";

    // 表格內容
    websites.forEach((site, index) => {
      const { title, url, hostname } = site;
      // 處理字段值，若為空則使用預設值
      const urlCell = `[${title || DEFAULT_TITLE}](${url || DEFAULT_URL})`;
      const hostnameCell = hostname || DEFAULT_HOSTNAME;
      if (mode === "table") {
        markdown += `| ${index + 1} | ${urlCell} | ${hostnameCell} |\n`;
      } else {
        markdown += `[${index + 1}] ${urlCell} | 來源: ${hostnameCell}\n`;
      }
    });

    return markdown;
  }

  /**
   * 取得所有帳戶資訊
   * @returns {Array} 帳戶列表
   */
  getAllAccountKeys() {
    return this.accountTokens;
  }

  /**
   * 使用者登入（委託給 TokenManager）
   * @param {string} email - 郵箱
   * @param {string} password - 密碼
   * @returns {Promise<string|null>} 令牌或null
   */
  async login(email, password, proxy) {
    const accountLike = proxy ? { proxy } : undefined;
    return await this.tokenManager.login(email, password, accountLike);
  }

  /**
   * 取得帳戶健康狀態統計
   * @returns {Object} 健康狀態統計
   */
  getHealthStats() {
    const tokenStats = this.tokenManager.getTokenHealthStats(
      this.accountTokens,
    );
    const rotatorStats = this.accountRotator.getStats();

    return {
      accounts: tokenStats,
      rotation: rotatorStats,
      initialized: this.isInitialized,
    };
  }

  /**
   * 記錄帳戶傳輸層失敗（影響 cooldown）
   * 僅在 timeout/ECONNRESET 等傳輸層錯誤調用——HTTP 4xx/5xx 走 recordAccountError
   * @param {string} email - 郵箱地址
   * @param {string|number} [code] - 錯誤碼（err.code 或 HTTP status）
   */
  recordAccountFailure(email, code) {
    this.accountRotator.recordFailure(email, code);
  }

  /**
   * 記錄帳戶錯誤（僅用於 UI warn 指示，不影響 cooldown）
   * HTTP 4xx/5xx 走這裡——上游主動拒絕，帳戶本身有效
   * @param {string} email - 郵箱地址
   * @param {string|number} [code] - HTTP status 或錯誤碼
   */
  recordAccountError(email, code) {
    this.accountRotator.recordError(email, code);
  }

  /**
   * 累計 daily stats（per-account）
   * 調用方：chat.js / anthropic.js / cli.chat.js 在成功消費完上游 usage 後
   * 注意：PM2_INSTANCES>1 時各 worker 各持一份 in-memory 副本（已記於 epic notes）
   * @param {string} email - 郵箱地址
   * @param {'chat'|'cli'} kind - 統計類別
   * @param {Object} delta - 增量
   * @param {number} [delta.input] - 輸入 tokens
   * @param {number} [delta.output] - 輸出 tokens
   * @param {number} [delta.calls] - 調用次數（僅 cli 使用）
   */
  accumulateStats(email, kind, delta) {
    if (!email || !delta) return;
    const account = this.accountTokens.find((acc) => acc.email === email);
    if (!account) return;

    ensureStats(account);

    const input = Number(delta.input) || 0;
    const output = Number(delta.output) || 0;
    const calls = Number(delta.calls) || 0;

    if (kind === "chat") {
      account.stats.chat.input += input;
      account.stats.chat.output += output;
    } else if (kind === "cli") {
      account.stats.cli.calls += calls;
      account.stats.cli.input += input;
      account.stats.cli.output += output;
    } else {
      return;
    }

    // 非同步 debounced persist——失敗不影響調用方
    try {
      this.dataPersistence.saveAccountStats(email, account.stats);
    } catch (error) {
      logger.error(
        `accumulateStats persist 調度失敗 (${email})`,
        "STATS",
        "",
        error,
      );
    }
  }

  /**
   * 重置帳戶失敗計數
   * @param {string} email - 郵箱地址
   */
  resetAccountFailures(email) {
    this.accountRotator.resetFailures(email);
  }

  /**
   * 新增新帳戶
   * @param {string} email - 郵箱
   * @param {string} password - 密碼
   * @param {string|null} [proxy] - 帳號專屬代理 URL（HTTP/HTTPS/SOCKS5）
   * @returns {Promise<boolean>} 新增是否成功
   */
  async addAccount(email, password, proxy = null) {
    try {
      // 檢查帳戶是否已存在
      const existingAccount = this.accountTokens.find(
        (acc) => acc.email === email,
      );
      if (existingAccount) {
        logger.warn(`帳戶 ${email} 已存在`, "ACCOUNT");
        return false;
      }

      // 嘗試登入取得令牌
      const token = await this.tokenManager.login(
        email,
        password,
        proxy ? { proxy } : undefined,
      );
      if (!token) {
        logger.error(`帳戶 ${email} 登入失敗，無法新增`, "ACCOUNT");
        return false;
      }

      const decoded = this.tokenManager.validateToken(token);
      if (!decoded) {
        logger.error(`帳戶 ${email} 令牌無效，無法新增`, "ACCOUNT");
        return false;
      }

      const newAccount = {
        email,
        password,
        token,
        expires: decoded.exp,
        proxy: typeof proxy === "string" && proxy.trim() ? proxy.trim() : null,
        stats: createDefaultStats(),
      };

      // 新增到內存
      this.accountTokens.push(newAccount);
      const insertedIndex = this.accountTokens.length - 1;

      // 保存到持久化存儲
      const saved = await this.dataPersistence.saveAccount(email, newAccount);
      if (!saved) {
        this.accountTokens.splice(insertedIndex, 1);
        this.accountRotator.setAccounts(this.accountTokens);
        logger.error(`帳戶 ${email} 持久化失敗，已回滾內存資料`, "ACCOUNT");
        return false;
      }

      // 更新輪詢器
      this.accountRotator.setAccounts(this.accountTokens);

      // 後臺初始化 CLI
      this._initializeCliAccount(newAccount).catch((err) => {
        logger.error(`新帳戶 CLI 初始化失敗: ${email}`, "ACCOUNT", "", err);
      });

      logger.success(`成功新增帳戶: ${email}`, "ACCOUNT");
      return true;
    } catch (error) {
      logger.error(`新增帳戶失敗 (${email})`, "ACCOUNT", "", error);
      return false;
    }
  }

  /**
   * 直接新增帳戶（已有token，無需登入）
   * @param {string} email - 郵箱
   * @param {string} password - 密碼
   * @param {string} token - 已取得的令牌
   * @param {number} expires - 過期時間戳
   * @param {string|null} [proxy] - 帳號專屬代理 URL
   * @returns {Promise<boolean>} 新增是否成功
   */
  async addAccountWithToken(email, password, token, expires, proxy = null) {
    try {
      // 檢查帳戶是否已存在
      const existingAccount = this.accountTokens.find(
        (acc) => acc.email === email,
      );
      if (existingAccount) {
        logger.warn(`帳戶 ${email} 已存在`, "ACCOUNT");
        return false;
      }

      const newAccount = {
        email,
        password,
        token,
        expires,
        proxy: typeof proxy === "string" && proxy.trim() ? proxy.trim() : null,
        stats: createDefaultStats(),
      };

      // 新增到內存
      this.accountTokens.push(newAccount);
      const insertedIndex = this.accountTokens.length - 1;

      // 保存到持久化存儲
      const saved = await this.dataPersistence.saveAccount(email, newAccount);
      if (!saved) {
        this.accountTokens.splice(insertedIndex, 1);
        this.accountRotator.setAccounts(this.accountTokens);
        logger.error(`帳戶 ${email} 持久化失敗，已回滾內存資料`, "ACCOUNT");
        return false;
      }

      // 更新輪詢器
      this.accountRotator.setAccounts(this.accountTokens);

      // 後臺初始化 CLI
      this._initializeCliAccount(newAccount).catch((err) => {
        logger.error(`新帳戶 CLI 初始化失敗: ${email}`, "ACCOUNT", "", err);
      });

      logger.success(`成功新增帳戶: ${email}`, "ACCOUNT");
      return true;
    } catch (error) {
      logger.error(`新增帳戶失敗 (${email})`, "ACCOUNT", "", error);
      return false;
    }
  }

  /**
   * 更新帳戶的代理 URL
   * 同時使舊 URL 對應的 agent 失效（釋放底層 socket）
   * @param {string} email - 郵箱
   * @param {string|null} proxy - 新代理 URL，空字符串/null 表示清除
   * @returns {Promise<boolean>} 更新是否成功
   */
  async updateAccountProxy(email, proxy) {
    try {
      const account = this.accountTokens.find((acc) => acc.email === email);
      if (!account) {
        logger.warn(`帳戶 ${email} 不存在`, "ACCOUNT");
        return false;
      }

      const oldProxy = account.proxy || null;
      const newProxy =
        typeof proxy === "string" && proxy.trim() ? proxy.trim() : null;

      if (oldProxy === newProxy) {
        logger.info(`帳戶 ${email} 代理未變化，無需更新`, "ACCOUNT");
        return true;
      }

      // 先更新內存，再持久化；持久化失敗時回滾
      account.proxy = newProxy;
      const saved = await this.dataPersistence.saveAccount(email, {
        password: account.password,
        token: account.token,
        expires: account.expires,
        proxy: newProxy,
      });
      if (!saved) {
        account.proxy = oldProxy;
        logger.error(`帳戶 ${email} 代理持久化失敗，已回滾內存資料`, "ACCOUNT");
        return false;
      }

      // 舊代理 URL 不再被該帳戶引用，主動失效快取
      // 注意：其他帳戶可能仍在使用同一 URL，但 invalidate 僅按 URL 操作；
      // 多帳戶共享代理的場景下後續請求會重新創建 agent，安全
      if (oldProxy && oldProxy !== newProxy) {
        const { invalidateProxyAgent } = require("./proxy-helper");
        invalidateProxyAgent(oldProxy);
      }

      logger.success(
        `帳戶 ${email} 代理更新成功 (${oldProxy || "無"} → ${newProxy || "無"})`,
        "ACCOUNT",
      );
      return true;
    } catch (error) {
      logger.error(`更新帳戶 ${email} 代理失敗`, "ACCOUNT", "", error);
      return false;
    }
  }

  /**
   * 移除帳戶
   * @param {string} email - 郵箱地址
   * @returns {Promise<boolean>} 移除是否成功
   */
  async removeAccount(email) {
    try {
      const index = this.accountTokens.findIndex((acc) => acc.email === email);
      if (index === -1) {
        logger.warn(`帳戶 ${email} 不存在`, "ACCOUNT");
        return false;
      }

      // 從內存中移除
      this.accountTokens.splice(index, 1);

      // 更新輪詢器
      this.accountRotator.setAccounts(this.accountTokens);

      logger.success(`成功移除帳戶: ${email}`, "ACCOUNT");
      return true;
    } catch (error) {
      logger.error(`移除帳戶失敗 (${email})`, "ACCOUNT", "", error);
      return false;
    }
  }

  /**
   * 刪除帳戶（向後相容）
   * @param {string} email - 郵箱地址
   * @returns {boolean} 刪除是否成功
   */
  deleteAccount(email) {
    const index = this.accountTokens.findIndex((t) => t.email === email);
    if (index !== -1) {
      this.accountTokens.splice(index, 1);
      this.accountRotator.setAccounts(this.accountTokens);
      return true;
    }
    return false;
  }

  /**
   * 為指定帳戶初始化CLI資訊（公共方法）
   * @param {Object} account - 帳戶物件
   * @returns {Promise<boolean>} 初始化是否成功
   */
  async initializeCliForAccount(account) {
    if (!account) {
      logger.error("帳戶物件不能為空", "CLI");
      return false;
    }

    try {
      await this._initializeCliAccount(account);
      return true;
    } catch (error) {
      logger.error(`為帳戶 ${account.email} 初始化CLI失敗`, "CLI", "", error);
      return false;
    }
  }

  /**
   * 延遲函式
   * @param {number} ms - 延遲毫秒數
   * @private
   */
  async _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 清理資源
   */
  destroy() {
    // 清理自動重新整理定時器
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    // 清理CLI請求次數重置定時器
    if (this.cliRequestNumberInterval) {
      clearTimeout(this.cliRequestNumberInterval);
      this.cliRequestNumberInterval = null;
    }

    if (this.cliDailyResetInterval) {
      clearInterval(this.cliDailyResetInterval);
      this.cliDailyResetInterval = null;
    }

    // 清理所有CLI帳戶的重新整理定時器
    this.accountTokens.forEach((account) => {
      if (account.cli_info && account.cli_info.refresh_token_interval) {
        clearInterval(account.cli_info.refresh_token_interval);
        account.cli_info.refresh_token_interval = null;
      }
    });

    this.accountRotator.reset();
    logger.info("帳戶管理器已清理資源", "ACCOUNT", "🧹");
  }
}

if (!(process.env.API_KEY || config.apiKey)) {
  logger.error("請務必設定 API_KEY 環境變量", "CONFIG", "⚙️");
  process.exit(1);
}

const accountManager = new Account();

// 新增進程退出時的清理
process.on("exit", () => {
  if (accountManager) {
    accountManager.destroy();
  }
});

// 處理意外退出
process.on("SIGINT", () => {
  if (accountManager) {
    accountManager.destroy();
  }
  process.exit(0);
});

module.exports = accountManager;
