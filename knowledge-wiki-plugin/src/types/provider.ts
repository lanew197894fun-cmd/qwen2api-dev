// Knowledge provider interface

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  useCount: number;
}

export interface LessonEntry {
  id: string;
  title: string;
  scenario: string;
  mistake: string;
  consequence: string;
  solution: string;
  prevention: string;
  severity: string;
  tags: string[];
  createdAt: string;
  triggerCount: number;
  status: "active" | "archived";
}

export interface WikiEntry {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  useCount: number;
}

export interface DuplicateGroup {
  keep: string;
  remove: string[];
  similarity: number;
}

export interface IKnowledgeProvider {
  /** Provider 名稱 */
  getName(): string;
  /** Provider 版本 */
  getVersion(): string;
  /** 初始化 */
  init(opts: { dir: string; cfg: Record<string, any> }): Promise<void>;
  /** 是否已初始化 */
  isInitialized(): boolean;

  // ── Knowledge ──
  saveKnowledge(entry: KnowledgeEntry): Promise<string>;
  listKnowledge(
    category?: string,
    sortBy?: string,
    limit?: number,
  ): Promise<KnowledgeEntry[]>;
  readKnowledge(
    title: string,
    category?: string,
  ): Promise<KnowledgeEntry | null>;
  deleteKnowledge(id: string): Promise<void>;

  // ── Lessons ──
  saveLesson(entry: LessonEntry): Promise<string>;
  listLessons(severity?: string): Promise<LessonEntry[]>;

  // ── Wiki ──
  saveWiki(entry: WikiEntry): Promise<string>;
  listWiki(category?: string, limit?: number): Promise<WikiEntry[]>;
  readWiki(title: string, category?: string): Promise<WikiEntry | null>;

  // ── Utility ──
  checkDuplicate(
    base: string,
    content: string,
    threshold?: number,
  ): Promise<{ file: string; similarity: number } | null>;
  deduplicate(
    threshold: number,
    dryRun: boolean,
  ): Promise<{
    groups: DuplicateGroup[];
    removed: number;
  }>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
