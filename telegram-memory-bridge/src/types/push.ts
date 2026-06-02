// Telegram Memory Bridge — push types
// 共用 type definitions，兩端（master/peer）共用

/** 推送設定 */
export interface PushOpts {
  peerUrl: string;
  memoryRoot: string;
  knowledgeRoot: string;
  wikiRoot: string;
}

/** 已推送歷史紀錄（去重用） */
export interface PushHistory {
  memory: string[];
  knowledge: string[];
  wiki: string[];
}

/** 推送記憶 payload */
export interface PushMemoryPayload {
  summary: string;
  category?: string;
  importance?: number;
  tags?: string[];
  content?: string;
  _peer: string;
}

/** 推送知識 payload */
export interface PushKnowledgePayload {
  title: string;
  content: string;
  category?: string;
  tags?: string[];
  _peer: string;
}

/** 推送維基 payload */
export interface PushWikiPayload {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  _peer: string;
}

/** 推送結果 */
export interface PushResult {
  memory: number;
  knowledge: number;
  wiki: number;
  errors: number;
}

/** 角色模式 */
export type Role = "master" | "peer" | "standalone";

/** 平台狀態 */
export interface PlatformState {
  tailscale: boolean;
  hasPeers: boolean;
  hasToken: boolean;
  role: Role;
  localIP: string;
  peers: string[];
}
