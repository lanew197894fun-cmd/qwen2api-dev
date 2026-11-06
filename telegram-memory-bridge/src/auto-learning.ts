// auto-learning.ts — 自我學習自動觸發邏輯
// 依據對話內容與系統事件，自動判斷何時該記錄經驗教訓（Lesson）或知識（Knowledge）

import type { MemStore } from "./store.ts";
import type { FileProvider } from "../../knowledge-wiki-plugin/src/provider/file-provider.ts";

export interface LearningTrigger {
  type: "lesson" | "knowledge" | "wiki";
  confidence: number; // 0-1，觸發信心指數
  reason: string; // 觸發原因
  payload: Record<string, string>; // 儲存所需的參數
}

/**
 * 分析使用者訊息與 AI 回應，判斷是否應自動記錄
 * @param userMsg 使用者訊息
 * @param aiResponse AI 回應
 * @param store MemStore 實例（用於查詢歷史）
 */
export async function analyzeForLearning(
  userMsg: string,
  aiResponse: string,
  store: MemStore,
): Promise<LearningTrigger | null> {
  const combined = `${userMsg}\n${aiResponse}`;

  // 1. 錯誤修復模式：偵測「問題 → 解決」結構
  if (isErrorFixPattern(userMsg, aiResponse)) {
    return {
      type: "lesson",
      confidence: 0.85,
      reason: "偵測到錯誤修復對話結構",
      payload: {
        title: extractTitle(userMsg),
        scenario: userMsg.slice(0, 200),
        mistake: extractMistake(userMsg),
        solution: aiResponse.slice(0, 500),
        severity: "P2",
      },
    };
  }

  // 2. 技術知識模式：偵測「如何做／設定／安裝」問答
  if (isTechnicalHowTo(userMsg, aiResponse)) {
    return {
      type: "knowledge",
      confidence: 0.75,
      reason: "偵測到技術操作指南",
      payload: {
        title: extractTitle(userMsg),
        content: aiResponse.slice(0, 2000),
        category: "technical",
        tags: "howto,guide",
      },
    };
  }

  // 3. 架構決策模式：偵測「選擇／比較／建議」對話
  if (isArchitectureDecision(userMsg, aiResponse)) {
    return {
      type: "wiki",
      confidence: 0.7,
      reason: "偵測到架構決策討論",
      payload: {
        title: extractTitle(userMsg),
        content: `## 決策背景\n${userMsg}\n\n## 建議方案\n${aiResponse}`,
        category: "architecture",
        tags: "decision,architecture",
      },
    };
  }

  return null;
}

// ── 模式偵測輔助函式 ──

function isErrorFixPattern(userMsg: string, aiResponse: string): boolean {
  const errorKws = [
    "錯誤",
    "失敗",
    "bug",
    "exception",
    "crash",
    "無法",
    "不能",
    "problem",
    "issue",
  ];
  const fixKws = [
    "修復",
    "解決",
    "fixed",
    "resolved",
    "解法",
    " workaround",
    "patch",
  ];
  const hasError = errorKws.some((k) => userMsg.toLowerCase().includes(k));
  const hasFix = fixKws.some((k) => aiResponse.toLowerCase().includes(k));
  return hasError && hasFix;
}

function isTechnicalHowTo(userMsg: string, aiResponse: string): boolean {
  const howToKws = [
    "如何",
    "怎麼",
    "安裝",
    "設定",
    "配置",
    "install",
    "setup",
    "configure",
    "step",
    "步驟",
  ];
  return howToKws.some((k) => userMsg.toLowerCase().includes(k));
}

function isArchitectureDecision(userMsg: string, aiResponse: string): boolean {
  const decisionKws = [
    "選擇",
    "比較",
    "建議",
    "架構",
    "design",
    "choose",
    "compare",
    "recommend",
    "pros and cons",
    "優缺點",
  ];
  return decisionKws.some((k) => userMsg.toLowerCase().includes(k));
}

function extractTitle(msg: string): string {
  // 簡單提取：取前 30 字作為標題
  return (
    msg
      .slice(0, 30)
      .replace(/[^\w\s\u4e00-\u9fff]/g, "")
      .trim() || "untitled"
  );
}

function extractMistake(msg: string): string {
  // 嘗試提取錯誤描述（簡化版：取整段訊息）
  return msg.slice(0, 300);
}

/**
 * 執行自動學習儲存（需手動確認或高信心時自動執行）
 */
export async function executeLearning(
  trigger: LearningTrigger,
  provider: FileProvider,
): Promise<{ ok: boolean; output: string }> {
  switch (trigger.type) {
    case "lesson": {
      const dup = await provider.checkDuplicate(
        "",
        trigger.payload.solution || "",
      );
      if (dup) {
        return {
          ok: true,
          output: `🔄 教訓已存在（相似度 ${(dup.similarity * 100).toFixed(1)}%）`,
        };
      }
      await provider.saveLesson({
        id: "",
        title: trigger.payload.title || "untitled",
        scenario: trigger.payload.scenario || "",
        mistake: trigger.payload.mistake || "",
        consequence: "",
        solution: trigger.payload.solution || "",
        prevention: "",
        severity: trigger.payload.severity || "P2",
        tags: [],
        createdAt: new Date().toISOString().slice(0, 10),
        triggerCount: 0,
        status: "active",
      });
      return { ok: true, output: `✅ 自動記錄教訓: ${trigger.payload.title}` };
    }
    case "knowledge": {
      const dup = await provider.checkDuplicate(
        "",
        trigger.payload.content || "",
      );
      if (dup) {
        return {
          ok: true,
          output: `🔄 知識已存在（相似度 ${(dup.similarity * 100).toFixed(1)}%）`,
        };
      }
      const path = await provider.saveKnowledge({
        id: "",
        title: trigger.payload.title || "untitled",
        content: trigger.payload.content || "",
        category: trigger.payload.category || "general",
        tags: (trigger.payload.tags || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean),
        source: "auto-learning",
        createdAt: new Date().toISOString().slice(0, 10),
        updatedAt: new Date().toISOString().slice(0, 10),
        useCount: 0,
      });
      return { ok: true, output: `✅ 自動記錄知識: ${path}` };
    }
    case "wiki": {
      const path = await provider.saveWiki({
        id: "",
        title: trigger.payload.title || "untitled",
        content: trigger.payload.content || "",
        category: trigger.payload.category || "general",
        tags: (trigger.payload.tags || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean),
        createdAt: new Date().toISOString().slice(0, 10),
        updatedAt: new Date().toISOString().slice(0, 10),
        useCount: 0,
      });
      return { ok: true, output: `✅ 自動記錄維基: ${path}` };
    }
  }
}
