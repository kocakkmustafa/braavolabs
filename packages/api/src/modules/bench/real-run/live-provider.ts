/**
 * LIVE provider adapter (BRA-P1-05-N3): reuses the existing provider
 * abstraction (`services/ai-client` `chatCompletion`); no new HTTP client.
 * Loaded ONLY by the CLI in `--live` mode (dynamic import), never by tests
 * that touch the network. The key is read from the environment at call
 * time, trimmed, and handed straight to the client; it is never logged,
 * stored or put in a report.
 *
 * ai-client imports `config/env`, which validates the whole API env schema
 * at import time. The minimum names that import needs are listed in
 * LIVE_ENV_REQUIRED_NAMES (values are never read or echoed here).
 */
import { keyEnvName, PROVIDER_TIMEOUT_MS, RealRunRefusal } from "./guards";
import type { ProviderCall } from "./runner";

/** Names the API env schema needs for ai-client to import (no defaults). */
export const LIVE_ENV_REQUIRED_NAMES = ["DATABASE_URL", "JWT_SECRET", "ENCRYPTION_KEY"] as const;

export interface ChatLike {
  (
    config: { provider: string; model: string; apiKey: string },
    system: string,
    messages: Array<{ role: "user"; content: string }>,
    maxTokens: number,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number }>;
}

export interface LiveDeps {
  /** Test seam: replaces the dynamic ai-client import. */
  loadChat?: () => Promise<ChatLike>;
  timeoutMs?: number;
}

async function defaultLoadChat(): Promise<ChatLike> {
  const mod = await import("../../../services/ai-client");
  return mod.chatCompletion as unknown as ChatLike;
}

/** Zod issue paths only (never values) from an import-time env failure. */
function envFailurePaths(e: unknown): string[] | null {
  const issues = (e as { issues?: Array<{ path?: unknown[] }> } | null)?.issues;
  if (!Array.isArray(issues)) return null;
  const paths = issues.map((i) => (Array.isArray(i.path) ? i.path.join(".") : "")).filter(Boolean);
  return [...new Set(paths)];
}

export async function createLiveProvider(
  env: Record<string, string | undefined>,
  deps: LiveDeps = {},
): Promise<ProviderCall> {
  let chat: ChatLike;
  try {
    chat = await (deps.loadChat ?? defaultLoadChat)();
  } catch (e) {
    const paths = envFailurePaths(e);
    if (paths) {
      throw new RealRunRefusal(
        "ENV_CONFIG_INVALID",
        `${paths.join(", ")} (required by ai-client's env schema: ${LIVE_ENV_REQUIRED_NAMES.join(", ")})`,
      );
    }
    throw e;
  }
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;

  return async (req) => {
    const name = keyEnvName(req.provider, env);
    if (!name) throw new Error("no key");
    const apiKey = (env[name] as string).trim();
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        chat({ provider: req.provider, model: req.model, apiKey }, req.system, [{ role: "user", content: req.prompt }], req.maxTokens),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
      return { content: res.content, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
