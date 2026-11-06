/**
 * config/paths.js — 跨裝置路徑集中定義（qwen2api-plugin 專用）
 *
 * 從專案根目錄的共用 paths.js 重新匯出，確保單一真相來源
 *
 * 用法：
 *   import { ROOT, OPENCODE_DIR, QWEN2API_DIR } from "./config/paths.js"
 */

// 從專案根目錄的共用 paths.js 匯入
import {
  ROOT,
  OPENCODE_DIR,
  QWEN2API_DIR,
  SYSTEM_DIR,
  LESSON_DIR,
  WIKI_DIR,
  KNOWLEDGE_DIR,
  MEMORY_DIR,
  MODELS_DIR,
  CONVERSATIONS_DIR,
} from "../../../config/paths.js";

// 重新匯出（保持向後相容）
export {
  ROOT,
  OPENCODE_DIR,
  QWEN2API_DIR,
  SYSTEM_DIR,
  LESSON_DIR,
  WIKI_DIR,
  KNOWLEDGE_DIR,
  MEMORY_DIR,
  MODELS_DIR,
  CONVERSATIONS_DIR,
};
