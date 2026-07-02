/**
 * Live provider model catalogue — E2/T10 API leg.
 *
 * Serves GET /settings/ai-providers/:provider/models. When the tenant has a
 * usable BYOK config for the requested provider, the provider's own
 * model-listing API is proxied just-in-time (5-minute per-tenant cache).
 * On ANY failure — no key, wrong provider, decrypt error, SSRF refusal,
 * timeout, non-2xx, unparseable body, empty list — the static
 * PROVIDER_MODELS catalogue is returned instead. The UI treats the static
 * list as a fallback, but the contract is stronger than that: this module
 * never lets an upstream failure escape as a 500 (plan-e2 T10).
 *
 * Provider wire formats:
 *   ANTHROPIC          — GET api.anthropic.com/v1/models        → { data:[{id}] }
 *   GOOGLE             — GET generativelanguage…/v1beta/models  → { models:[{name,supportedGenerationMethods}] }
 *   everything else    — GET {baseUrl}/models (OpenAI-compatible) → { data:[{id}] }
 *
 * Security notes:
 *   - The Gemini key travels in the `x-goog-api-key` HEADER, never the URL
 *     query string (mirrors the D-001 fix in ai-client.callGoogle — query
 *     keys leak into proxy/server logs).
 *   - OpenAI-compatible base URLs are tenant-controllable → the same SSRF
 *     policy as ai-client.callOpenAICompatible applies: loopback/private
 *     ranges only for local-first providers (OLLAMA/LMSTUDIO/CUSTOM) or
 *     OFFLINE_MODE deployments; cloud-metadata IPs refused for everyone.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { decryptForTenant } from "../../lib/encryption";
import { assertSafeExternalUrl } from "../../lib/ssrf";
import { env } from "../../config/env";
import {
  PROVIDER_MODELS,
  PROVIDER_BASE_URLS,
  LOCAL_PROVIDERS,
  type AIProviderType,
} from "../../services/ai-client";

// ─── Tunables ─────────────────────────────────────────────

/** Plan T10: "5dk cache" — per tenant × provider, in-memory (Lightsail is
 * single-instance; same trade-off as the T7 circuit breaker). */
export const MODEL_CACHE_TTL_MS = 5 * 60_000;

/** Plan T10: "timeout kısa" — a models listing is a tiny GET; anything
 * slower than this should degrade to the static catalogue, not block the
 * settings panel. Deliberately much shorter than the 60s/240s completion
 * timeouts in ai-client. */
export const LIVE_FETCH_TIMEOUT_MS = 5_000;

/**
 * OpenAI-compatible /models listings mix chat models with audio / image /
 * embedding / moderation endpoints (whisper-1, dall-e-3, text-embedding-3…).
 * Those can never drive the agent loop, so they are filtered out of the
 * selector. Substring match, lowercased. Kept small on purpose — an unknown
 * model id passes through rather than being wrongly hidden.
 */
const NON_CHAT_MODEL_SUBSTRINGS: readonly string[] = [
  "whisper", "tts", "embed", "dall-e", "moderation", "audio",
  "realtime", "transcribe", "davinci", "babbage", "image-", "sora",
];

// ─── Provider id validation ───────────────────────────────

/** Router-level guard: is `p` one of the 12 catalogue providers?
 * (Case-sensitive — the router uppercases before calling.) */
export function isKnownProvider(p: string): p is AIProviderType {
  return Object.prototype.hasOwnProperty.call(PROVIDER_MODELS, p);
}

// ─── 5-minute cache (tenantId × provider) ─────────────────

interface CacheEntry {
  models: string[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test hook — resets the in-memory cache between cases. */
export function clearProviderModelsCache(): void {
  cache.clear();
}

/** Cheap unbounded-growth guard: evict expired entries once the map gets
 * large. tenants × 12 providers stays tiny in practice; this is a fuse. */
function pruneCache(now: number): void {
  if (cache.size < 1_000) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

// ─── Live fetch per provider ──────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Pull trimmed, deduped string ids out of an unknown-shaped list. */
function extractIds(list: unknown, pick: (entry: Record<string, unknown>) => unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const id = pick(entry as Record<string, unknown>);
    if (typeof id === "string" && id.trim()) out.add(id.trim());
  }
  return [...out];
}

function isChatModelId(id: string): boolean {
  const m = id.toLowerCase();
  return !NON_CHAT_MODEL_SUBSTRINGS.some((s) => m.includes(s));
}

/**
 * Call the provider's model-listing API. Returns `null` when the listing
 * can't be produced (missing URL, non-2xx, unexpected shape) — the caller
 * maps that to the static fallback. Network/SSRF/timeout errors throw and
 * are caught by getProviderModels' outer try.
 */
async function fetchLiveModels(
  provider: AIProviderType,
  cfg: { apiKey: string; baseUrl?: string },
): Promise<string[] | null> {
  if (provider === "ANTHROPIC") {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    return extractIds(body?.data, (e) => e.id);
  }

  if (provider === "GOOGLE") {
    // Key in the header, NOT `?key=` (D-001 pattern — see module docblock).
    const res = await fetchWithTimeout(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": cfg.apiKey } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body?.models)) return null;
    // Keep only models that can actually chat (generateContent); tolerate
    // the capability field being absent on future API versions.
    const usable = (body.models as Array<Record<string, unknown>>).filter((m) => {
      const methods = m.supportedGenerationMethods;
      return !Array.isArray(methods) || methods.includes("generateContent");
    });
    return extractIds(usable, (e) =>
      typeof e.name === "string" ? e.name.replace(/^models\//, "") : undefined,
    );
  }

  // OpenAI-compatible: OPENAI / MISTRAL / GROQ / OPENROUTER / DEEPSEEK /
  // KIMI / QWEN / OLLAMA / LMSTUDIO / CUSTOM — all expose GET /models.
  const defaultUrl = PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS];
  const baseUrl = (cfg.baseUrl?.trim() || defaultUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return null; // CUSTOM without a saved base URL

  // Same SSRF policy as ai-client.callOpenAICompatible (see docblock).
  const isLocal = LOCAL_PROVIDERS.has(provider);
  await assertSafeExternalUrl(baseUrl, {
    allowLoopback: isLocal,
    allowPrivateNetworks: isLocal || env.OFFLINE_MODE,
  });

  const headers: Record<string, string> = {};
  // Local providers often run without auth — only send the header when a
  // key exists (mirrors ai-client).
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  // OpenRouter attribution headers (D-003 parity with ai-client).
  if (provider === "OPENROUTER") {
    headers["HTTP-Referer"] = "https://braavolabs.com";
    headers["X-Title"] = "Braavolabs";
  }

  const res = await fetchWithTimeout(`${baseUrl}/models`, { headers });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: unknown; models?: unknown };
  // Standard OpenAI shape is { data:[{id}] }; a few compatible servers
  // (older Ollama builds) answer { models:[{name}] } — accept both.
  const ids = extractIds(body?.data ?? body?.models, (e) => e.id ?? e.name);
  return ids.filter(isChatModelId);
}

// ─── Public entry point ───────────────────────────────────

export interface ProviderModelsResult {
  provider: AIProviderType;
  models: string[];
  /** "live" = fetched from the provider now (or ≤5 min ago);
   *  "static" = PROVIDER_MODELS fallback catalogue. */
  source: "live" | "static";
}

/**
 * Model catalogue for one provider, as seen by one tenant.
 * NEVER rejects for upstream/provider reasons — every failure path returns
 * the static catalogue (the router additionally guards against programmer
 * errors so the endpoint can't 500).
 */
export async function getProviderModels(
  tenantId: string,
  provider: AIProviderType,
): Promise<ProviderModelsResult> {
  const staticResult: ProviderModelsResult = {
    provider,
    models: PROVIDER_MODELS[provider],
    source: "static",
  };

  const now = Date.now();
  const cacheKey = `${tenantId}:${provider}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { provider, models: cached.models, source: "live" };
  }

  try {
    // The tenant's config row FOR THIS provider. `findFirst` on
    // (tenantId, provider) is deliberately schema-agnostic: it is correct
    // both in the single-row BYOK world (tenantId @unique — a request for
    // any provider other than the configured one simply matches nothing)
    // and after the T6 multi-key migration (@@unique([tenantId, provider])
    // — it matches exactly the per-provider row).
    const aiConfig = await prisma.userAIConfig.findFirst({ where: { tenantId, provider } });
    if (!aiConfig) return staticResult;

    const isLocal = LOCAL_PROVIDERS.has(provider);
    let apiKey = "";
    if (aiConfig.encryptedApiKey) {
      // Throws on corrupt/undecryptable keys → outer catch → static
      // (same D-002 stance as getTenantAIConfig: never call out with "").
      apiKey = decryptForTenant(aiConfig.encryptedApiKey, tenantId);
    }
    // Cloud providers can't list models without a key; local ones can.
    if (!apiKey && !isLocal) return staticResult;

    const live = await fetchLiveModels(provider, {
      apiKey,
      baseUrl: aiConfig.baseUrl?.trim() || undefined,
    });
    if (!live || live.length === 0) return staticResult;

    pruneCache(now);
    cache.set(cacheKey, { models: live, expiresAt: now + MODEL_CACHE_TTL_MS });
    return { provider, models: live, source: "live" };
  } catch (err) {
    logger.info(
      { tenantId, provider, err: err instanceof Error ? err.message : String(err) },
      "Live provider model listing failed — serving static catalogue",
    );
    return staticResult;
  }
}
