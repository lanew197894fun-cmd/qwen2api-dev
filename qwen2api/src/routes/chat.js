const express = require("express");
const multer = require("multer");
const router = express.Router();
const { apiKeyVerify } = require("../middlewares/authorization.js");
const { processRequestBody } = require("../middlewares/chat-middleware.js");
const { validateChat } = require("../middlewares/validator.js");
const { handleChatCompletion } = require("../controllers/chat.js");
const {
  handleImageVideoCompletion,
  handleOpenAIImagesGeneration,
  handleOpenAIImagesEdit,
  handleOpenAIVideoGeneration,
} = require("../controllers/chat.image.video.js");

// ─── 檔案上傳過濾：僅允許圖片與影片 ───
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/mpeg",
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`不支援的檔案類型: ${file.mimetype}`), false);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  fileFilter: fileFilter,
});

const selectChatCompletion = (req, res, next) => {
  const ChatCompletionMap = {
    t2t: handleChatCompletion,
    search: handleChatCompletion,
    t2i: handleImageVideoCompletion,
    t2v: handleImageVideoCompletion,
    image_edit: handleImageVideoCompletion,
    //   'deep_research': handleDeepResearchCompletion
  };

  const chatType = req.body.chat_type;
  const chatCompletion = ChatCompletionMap[chatType];
  if (chatCompletion) {
    Promise.resolve(chatCompletion(req, res, next)).catch(next);
  } else {
    Promise.resolve(handleImageVideoCompletion(req, res, next)).catch(next);
  }
};

router.post(
  "/v1/chat/completions",
  apiKeyVerify,
  processRequestBody, // 先標準化請求體
  validateChat,       // 再驗證標準化後的資料
  selectChatCompletion,
);

router.post(
  "/v1/images/generations",
  apiKeyVerify,
  handleOpenAIImagesGeneration,
);

router.post(
  "/v1/images/edits",
  apiKeyVerify,
  upload.any(),
  handleOpenAIImagesEdit,
);

router.post(
  "/v1/videos",
  apiKeyVerify,
  upload.any(),
  handleOpenAIVideoGeneration,
);

module.exports = router;
