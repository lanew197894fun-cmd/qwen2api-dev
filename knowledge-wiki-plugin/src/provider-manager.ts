// Provider manager - singleton

import type { IKnowledgeProvider } from "./types/provider";

class ProviderManager {
  private providers = new Map<string, IKnowledgeProvider>();
  private active: IKnowledgeProvider | null = null;
  private fallback: IKnowledgeProvider | null = null;

  register(name: string, provider: IKnowledgeProvider) {
    this.providers.set(name, provider);
  }

  async activate(
    name: string,
    opts: { dir: string; cfg: Record<string, any> },
  ) {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider "${name}" not registered`);
    await p.init(opts);
    this.active = p;
  }

  get(): IKnowledgeProvider {
    if (this.active) return this.active;
    if (this.fallback) return this.fallback;
    throw new Error("No active provider");
  }

  setFallback(p: IKnowledgeProvider) {
    this.fallback = p;
  }

  isReady(): boolean {
    return this.active?.isInitialized() ?? false;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  async healthCheck(): Promise<boolean> {
    return this.active?.healthCheck() ?? false;
  }

  async closeAll() {
    for (const p of this.providers.values()) {
      try {
        await p.close();
      } catch {
        /* ignore */
      }
    }
    this.active = null;
    this.fallback = null;
    this.providers.clear();
  }
}

export const providerManager = new ProviderManager();
