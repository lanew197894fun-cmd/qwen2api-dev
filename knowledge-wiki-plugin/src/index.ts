// knowledge-wiki-plugin - 主入口

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { FileProvider } from "./provider/file-provider";
import { providerManager } from "./provider-manager";
import { getTools } from "./tools";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

  // Register default file provider
  const fileProvider = new FileProvider();
  providerManager.register("file", fileProvider);

  // Activate file provider with config
  await providerManager.activate("file", { dir, cfg });

  return {
    tool: getTools(),
  };
}

export default {
  id: "knowledge-wiki-plugin",
  server: KnowledgeWikiPlugin,
};
