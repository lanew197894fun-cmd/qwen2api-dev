// Telegram Memory Bridge — types

export interface MemEntry {
  id: string;
  category: "preference" | "fact" | "decision" | "entity" | "event" | "pattern";
  created: string;
  importance: number;
  tags: string[];
  summary: string;
  device?: string; // 裝置標記（來源區分）
}

export interface MemFile {
  frontmatter: {
    category: string;
    created: string;
    importance: number;
    tags: string[];
    device?: string;
  };
  content: string;
}

export interface SyncState {
  lastSync: string;
  syncedIds: string[];
  telegramChatId?: number;
}

export interface StoreResult {
  id: string;
  path: string;
  synced: boolean;
  /** 內容重複而跳過寫入（冪等性命中） */
  skipped?: boolean;
}

export interface RecallResult {
  entries: {
    id: string;
    score: number;
    summary: string;
    tags: string[];
    category: string;
    device?: string;
  }[];
  total: number;
}

export interface ApiError {
  error: string;
  detail?: string;
}
