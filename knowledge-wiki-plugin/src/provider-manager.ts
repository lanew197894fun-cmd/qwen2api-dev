// Provider manager - singleton with timeout & auto-degradation

import type { IKnowledgeProvider } from "./types/provider";

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

class ProviderManager {
  private providers = new Map<string, IKnowledgeProvider>();
  private active: IKnowledgeProvider | null = null;
  private fallback: IKnowledgeProvider | null = null;
  /** True if degraded from primary to fallback */
  private degraded = false;
  private initTimeoutMs = 30_000;

  setName(name: string) {
    /* reserved for future use */
  }

  register(name: string, provider: IKnowledgeProvider) {
    this.providers.set(name, provider);
  }

  /**
   * Activate provider by name with timeout protection.
   * On failure, auto-degrades to fallback if available.
   */
  async activate(
    name: string,
    opts: { dir: string; cfg: Record<string, any> },
  ): Promise<boolean> {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider "${name}" not registered`);
    try {
      await withTimeout(
        p.init(opts),
        this.initTimeoutMs,
        `Provider "${name}".init`,
      );
      this.active = p;
      this.degraded = false;
      return true;
    } catch (err) {
      console.error(`[provider-manager] activate "${name}" failed:`, err);
      // Auto-degrade to fallback
      if (this.fallback) {
        const fb = this.fallback;
        try {
          await withTimeout(fb.init(opts), this.initTimeoutMs, "Fallback.init");
          this.active = fb;
          this.degraded = true;
          console.warn(
            `[provider-manager] degraded to fallback after "${name}" failure`,
          );
          return true;
        } catch (fbErr) {
          console.error(`[provider-manager] fallback also failed:`, fbErr);
        }
      }
      // No fallback or fallback also failed — keep active null
      return false;
    }
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

  isDegraded(): boolean {
    return this.degraded;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Health check with auto-degradation.
   * If active fails health, try fallback and swap if it passes.
   */
  async healthCheck(): Promise<boolean> {
    if (this.active) {
      const ok = await this.active.healthCheck().catch(() => false);
      if (ok) return true;
      // Active is unhealthy — try fallback
      if (this.fallback) {
        const fbOk = await this.fallback.healthCheck().catch(() => false);
        if (fbOk) {
          console.warn(
            `[provider-manager] active "${this.active.getName()}" unhealthy, swapping to fallback`,
          );
          this.active = this.fallback;
          this.degraded = true;
          return true;
        }
      }
      return false;
    }
    return this.fallback?.healthCheck() ?? false;
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
