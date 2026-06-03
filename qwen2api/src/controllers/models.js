const { getLatestModels } = require("../models/models-map.js");
const config = require("../config/index.js");

/**
 * Claude CLI 相容模型映射表
 * 將 Qwen 模型 ID 映射為 Claude CLI 可接受的 Anthropic 風格 ID
 */
const CLAUDE_COMPAT_MAP = {
  "Qwen3.6-Max-Preview": "claude-sonnet-4-5",
  "Qwen3.7-Max": "claude-opus-4-1",
  "Qwen3.6-Plus": "claude-sonnet-4",
  "Qwen3.5-Flash": "claude-haiku-3-5",
  "Qwen3-Coder": "claude-sonnet-4-coding",
};

/**
 * 構造對外暴露的模型資訊
 * @param {object} model - 原始模型資訊
 * @param {string} suffix - 變體字尾
 * @param {boolean} anthropicCompat - 是否啟用 Anthropic 相容模式
 * @returns {object} 對外模型資訊
 */
const buildPublicModelData = (model, suffix = "", anthropicCompat = false) => {
  const modelData = JSON.parse(JSON.stringify(model));
  const upstreamModelID = String(model?.id || "");
  const displayModelID = String(model?.name || model?.id || "");

  const fullId = `${displayModelID}${suffix}`;

  // 若啟用 Anthropic 相容模式且存在映射，使用映射後的 ID
  const compatId = anthropicCompat ? CLAUDE_COMPAT_MAP[fullId] : null;

  modelData.id = compatId || fullId;
  modelData.name = `${upstreamModelID}${suffix}`;
  modelData.upstream_id = upstreamModelID;
  modelData.display_name = displayModelID;

  // 保留原始 Qwen ID 供內部使用
  if (compatId) {
    modelData.original_id = fullId;
  }

  return modelData;
};

// ⚪ 模型白名單：空字串 = 允許全部
// 若要限定，設 MODEL_ALLOWLIST=qwen3.7-max,qwen3.7-plus,opencode-zen
const MODEL_ALLOWLIST = (process.env.MODEL_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const handleGetModels = async (req, res) => {
  const models = [];

  let ModelsMap = await getLatestModels();

  // 🐛 FIX: 上游模型快取尚未刷新（WAF/API 初始化中）時，
  //         直接用白名單當降級，確保 /v1/models 永遠有值
  if (ModelsMap.length === 0 && MODEL_ALLOWLIST.length > 0) {
    ModelsMap = MODEL_ALLOWLIST.map((id) => ({
      id,
      name: id,
      info: { meta: {} },
    }));
  }

  // 檢測是否為 Claude CLI 請求（透過 User-Agent 或特定 header）
  const isClaudeCli =
    req.headers["user-agent"]?.includes("claude-cli") ||
    req.headers["x-claude-compat"] === "true";

  for (const model of ModelsMap) {
    const modelId = (model.id || model.name || "").toLowerCase();

    // 白名單篩選：有設定白名單時只保留匹配的模型
    if (MODEL_ALLOWLIST.length > 0 && !MODEL_ALLOWLIST.includes(modelId)) {
      continue;
    }

    models.push(buildPublicModelData(model, "", isClaudeCli));

    if (config.simpleModelMap) {
      continue;
    }

    const isThinking = model?.info?.meta?.abilities?.thinking;
    const isSearch = model?.info?.meta?.chat_type?.includes("search");
    const isImage = model?.info?.meta?.chat_type?.includes("t2i");
    const isVideo = model?.info?.meta?.chat_type?.includes("t2v");
    const isImageEdit = model?.info?.meta?.chat_type?.includes("image_edit");
    const isDeepResearch =
      model?.info?.meta?.chat_type?.includes("deep_research");
    const isCoder =
      model?.info?.meta?.abilities?.coding ||
      model?.info?.meta?.chat_type?.includes("coder") ||
      model?.id?.includes("coder") ||
      model?.name?.includes("coder") ||
      (model?.info?.meta?.mcp || []).includes("code-interpreter");

    if (isThinking) {
      models.push(buildPublicModelData(model, "-thinking", isClaudeCli));
    }

    if (isSearch) {
      models.push(buildPublicModelData(model, "-search", isClaudeCli));
    }

    if (isThinking && isSearch) {
      models.push(buildPublicModelData(model, "-thinking-search", isClaudeCli));
    }

    if (isImage) {
      models.push(buildPublicModelData(model, "-image", isClaudeCli));
    }

    if (isVideo) {
      models.push(buildPublicModelData(model, "-video", isClaudeCli));
    }

    if (isImageEdit) {
      models.push(buildPublicModelData(model, "-image-edit", isClaudeCli));
    }

    // 添加對 coder 模型的支持
    if (isCoder) {
      models.push(buildPublicModelData(model, "-coder", isClaudeCli));
    }

    if (isThinking && isCoder) {
      models.push(buildPublicModelData(model, "-thinking-coder", isClaudeCli));
    }

    if (isSearch && isCoder) {
      models.push(buildPublicModelData(model, "-search-coder", isClaudeCli));
    }

    if (isThinking && isSearch && isCoder) {
      models.push(
        buildPublicModelData(model, "-thinking-search-coder", isClaudeCli),
      );
    }
  }
  res.json({
    object: "list",
    data: models,
  });
};
module.exports = {
  handleGetModels,
};
