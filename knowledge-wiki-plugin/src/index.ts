/**
 * knowledge-wiki-plugin - 主入口
 *
 * 優先偵測 globalThis.__opencode_knowledge_provider__（LanceDB 後端），
 * 無則退回 FileProvider（Markdown 檔案系統）。
 *
 * 錯誤隔離：LanceDB 初始化失敗不會導致插件崩潰，自動降級至 FileProvider。
 *
 * @signature 2026-07-08 fix — add timeout control, error isolation & auto-degradation
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { FileProvider } from "./provider/file-provider";
import { providerManager } from "./provider-manager";
import { getTools } from "./tools";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GLOBAL_KEY = "__opencode_knowledge_provider__";

function loadConfig(pluginDir: string): Record<string, any> {
  const cfgPath = join(pluginDir, "config.json");
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    return {};
  }
}

export async function KnowledgeWikiPlugin(input: PluginInput): Promise<Hooks> {
  const dir = input.directory || process.cwd();
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const cfg = loadConfig(pluginDir);

  // Always register FileProvider as fallback first
  const fileProvider = new FileProvider();
  providerManager.register("file", fileProvider);
  providerManager.setFallback(fileProvider);

  // Attempt LanceDB primary; error isolation so failure never crashes plugin
  const lancedbProvider = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  let activated = false;

  if (
    lancedbProvider &&
    typeof lancedbProvider === "object" &&
    "saveKnowledge" in (lancedbProvider as any)
  ) {
    try {
      providerManager.register("lancedb", lancedbProvider as any);
      activated = await providerManager.activate("lancedb", { dir, cfg });
    } catch (err) {
      console.error(
        "[knowledge-wiki-plugin] LanceDB registration/activation error:",
        err,
      );
    }
  }

  if (activated) {
    const label = providerManager.isDegraded() ? " (degraded)" : "";
    console.log(
      `[knowledge-wiki-plugin] using LanceDB provider${label} from memory-lancedb-pro`,
    );
  } else {
    // Fallback: activate FileProvider
    try {
      await providerManager.activate("file", { dir, cfg });
      console.log(
        "[knowledge-wiki-plugin] using FileProvider (LanceDB unavailable or failed)",
      );
    } catch (err) {
      console.error(
        "[knowledge-wiki-plugin] FileProvider also failed, running with degraded tools:",
        err,
      );
    }
  }

  const tools = providerManager.isReady() ? getTools() : undefined;
  return { tool: tools };
}

export default {
  id: "knowledge-wiki-plugin",
  server: KnowledgeWikiPlugin,
};
