const { z } = require("zod");
const { logger } = require("../utils/logger");

// ─── Chat 請求驗證 Schema ───
const chatSchema = z.object({
  model: z.string().min(1, "Model 名稱不可為空"),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system", "tool"], {
          errorMap: () => ({
            message: "Role 必須是 user、assistant、system 或 tool",
          }),
        }),
        content: z
          .union([
            z.string().min(0).optional().default(""),
            z.array(z.any()),
            z.null(),
          ])
          .optional()
          .default(""),
      }),
    )
    .min(1, "至少需要一則訊息"),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  requestId: z.string().uuid().optional(), // 冪等性保護 ID
});

// ─── Account 登入驗證 Schema ───
const loginSchema = z.object({
  email: z.string().email("無效的 Email 格式"),
  password: z.string().min(6, "密碼至少 6 個字元"),
});

// ─── 通用驗證中間件工廠 ───
function createValidator(schema) {
  return (req, res, next) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError && error.errors) {
        logger.warn(
          `輸入驗證失敗: ${error.errors.map((e) => e.message).join(", ")}`,
          "VALIDATOR",
        );
        return res.status(400).json({
          error: "Invalid request body",
          details: error.errors.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        });
      }
      // 非 ZodError 或格式異常 → 直接拋給 error handler
      next(error);
    }
  };
}

module.exports = {
  validateChat: createValidator(chatSchema),
  validateLogin: createValidator(loginSchema),
  chatSchema,
  loginSchema,
};
