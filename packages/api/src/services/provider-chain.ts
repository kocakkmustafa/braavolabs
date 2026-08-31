/**
 * Provider chain — auto-mode failover primitives (E2/T7, plan §2.2 Karar B).
 *
 * Three concerns, one small module:
 *
 *   1. classifyProviderError() — TRANSIENT / FAILOVER / FATAL verdict for an
 *      error surfaced by a provider call. Conceptually adapted from
 *      claude-octopus `scripts/provider-router.sh classify_provider_error`
 *      (bash transient/permanent tables → TS, message+status heuristics) —
 *      not a copy; our error surface is the ai-client transports' own
 *      message format plus SDK errors carrying `.status`.
 *
 *   2. An in-memory circuit breaker keyed on tenant×provider — 3 failures
 *      inside a 5-minute window opens the circuit for a 5-minute cooldown.
 *      Instance-local by design: the Lightsail deployment is single-instance
 *      (plan §2.2 ruling). NOTE for the multi-instance future: move this
 *      state to Redis (same keys, INCR+EXPIRE) — do NOT scale out with the
 *      Map version, each instance would need its own failure budget.
 *
 *   3. buildTenantProviderChain() — the D-009-corrected resolution order:
 *
 *        BYOK/local default row → tenant's own fallbackOrder rows (asc)
 *
 *      Privacy rule (BR-P0-002-D, binding): auto-failover only ever walks
 *      providers the TENANT configured. Historical trial/system flags and
 *      Braavolabs-held keys are ignored by this resolver.
 *
 *      Failover is default-OFF end to end: fresh rows have
 *      fallbackOrder=NULL (not part of the chain) and
 *      allowSystemFallback=false, so a newly configured tenant gets exactly
 *      one link = today's static behaviour.
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import {
  createTenantApiKeyResolver,
  LOCAL_PROVIDERS,
  TENANT_CREDENTIAL_MARKER,
  ToolsUnsupportedError,
  type AIClientConfig,
  type AIProviderType,
} from "./ai-client";

// ─── Error classification ─────────────────────────────────

/**
 * TRANSIENT — same-provider retry class (429 / 5xx / timeout / network).
 *   The transports already retry these internally (callOpenAICompatible's
 *   backoff loop; withRetry around Anthropic/Gemini in claude.ts), so a
 *   TRANSIENT error that SURFACES to the agent loop is retry-exhausted —
 *   the loop treats it as failover-eligible (plan §2.2: "retry'ları tükenen
 *   429 → zincirde sonraki").
 * FATAL — request-shape errors (400-class). Failing over would replay the
 *   same doomed request on another provider's wallet — never chain these
 *   (plan risk table: "FATAL(400) zincire sokup maliyeti N× katlar").
 * FAILOVER — auth / quota / credit: this provider cannot serve, the next
 *   link might.
 */
export type ProviderErrorClass = "TRANSIENT" | "FAILOVER" | "FATAL";

const FAILOVER_STATUS = new Set([401, 402, 403]);
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const FATAL_STATUS = new Set([400, 404, 405, 413, 415, 422]);

const FAILOVER_TOKENS =
  /insufficient[_\s-]?quota|quota[_\s-]?exceeded|credit|billing|invalid[_\s-]?api[_\s-]?key|api[_\s-]?key[_\s-]?(?:invalid|expired|revoked)|authentication|unauthorized|permission[_\s-]?denied|access[_\s-]?terminated/i;
const TRANSIENT_TOKENS =
  /rate[_\s-]?limit|overloaded|timeout|timed[_\s-]?out|unreachable|econnrefused|econnreset|etimedout|enotfound|socket|fetch failed|network/i;

/** Pull an HTTP status out of an error: SDK `.status` / `.statusCode`
 * first, then the ai-client transports' own message format
 * ("<PROVIDER> API error 429: …"). */
function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const anyErr = err as { status?: unknown; statusCode?: unknown };
    if (typeof anyErr.status === "number") return anyErr.status;
    if (typeof anyErr.statusCode === "number") return anyErr.statusCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  const m = /(?:error|status)\s+(\d{3})\b/i.exec(message) ?? /\b(\d{3}):/.exec(message);
  if (m) return Number(m[1]);
  return undefined;
}

export function classifyProviderError(err: unknown): ProviderErrorClass {
  // Capability verdict, not a provider fault — the loop downgrades to
  // prompt-embedding BEFORE classification ever runs; this is defensive
  // (the same model would reject tools on a re-dial too).
  if (err instanceof ToolsUnsupportedError) return "FATAL";

  const message = err instanceof Error ? err.message : String(err);
  const status = extractStatus(err);

  if (status !== undefined) {
    if (FAILOVER_STATUS.has(status)) return "FAILOVER";
    if (TRANSIENT_STATUS.has(status)) return "TRANSIENT";
    if (FATAL_STATUS.has(status)) return "FATAL";
  }
  if (FAILOVER_TOKENS.test(message)) return "FAILOVER";
  if (TRANSIENT_TOKENS.test(message)) return "TRANSIENT";

  // Unknown errors default to TRANSIENT: the transports already burned
  // their same-provider retries, the chain is short (tenant-configured
  // links only) and every turn is budget-checked — advancing is bounded,
  // hanging a run on an unclassified blip is not.
  return "TRANSIENT";
}

/** FATAL never advances the chain; everything else may (surfaced TRANSIENT
 * errors are retry-exhausted by construction — see class docs above). */
export function isFailoverEligible(cls: ProviderErrorClass): boolean {
  return cls !== "FATAL";
}

/** Public status extractor — the E3 marker records what extractStatus saw so
 * downstream consumers (handoff trigger) don't re-parse the message. */
export function extractProviderErrorStatus(err: unknown): number | undefined {
  return extractStatus(err);
}

/**
 * E3/T3 marker (§2.3b — B3): thrown by the agent loop when the tenant's
 * provider chain is EXHAUSTED by a failover-eligible error (FAILOVER class,
 * or a retry-exhausted TRANSIENT). It is the ONLY error class allowed to
 * open an automatic handoff ledger — the executor's catch sees every error
 * in the process (Prisma failures, "No AI provider configured", plain code
 * bugs) and classifyProviderError defaults unknowns to TRANSIENT, so a bare
 * "FAILOVER|TRANSIENT → handoff" rule would inflate the ledger with
 * meaningless "continue with another provider" suggestions.
 *
 * The message mirrors the cause's message so run/step error strings (and
 * every `.toThrow(/…/)` consumer) read exactly as before the wrap.
 */
export class ProviderExhaustedError extends Error {
  /** Sanitized compatibility cause; never the raw upstream exception/body. */
  public readonly original: Error;

  constructor(
    /** classifyProviderError verdict on the final chain link's error. */
    public readonly classification: ProviderErrorClass,
    /** HTTP status when extractStatus recovered one (undefined = default-
     * TRANSIENT guess — NOT handoff-eligible, see isHandoffTriggerEligible). */
    public readonly status: number | undefined,
    /** Provider/model of the LAST link that failed (handoff fromProvider). */
    public readonly provider: AIProviderType,
    public readonly model: string,
    /** Raw input is used only to extract status before construction. */
    _original: unknown,
  ) {
    super(`${provider} provider chain exhausted` + (status ? ` with status ${status}` : ""));
    this.name = "ProviderExhaustedError";
    this.original = Object.assign(new Error(this.message), {
      name: "SanitizedProviderCause",
      ...(status ? { status } : {}),
    });
  }

  static wrap(
    classification: ProviderErrorClass,
    provider: AIProviderType,
    model: string,
    err: unknown,
  ): ProviderExhaustedError {
    return new ProviderExhaustedError(classification, extractStatus(err), provider, model, err);
  }
}

/**
 * B3 trigger guard: automatic handoffs fire ONLY on a marked chain-exhaustion
 * whose classification is trustworthy — explicit FAILOVER (auth/quota/credit)
 * or a TRANSIENT with a REAL HTTP status. A default-TRANSIENT (unknown error
 * that merely fell through the classifier) never opens a ledger.
 */
export function isHandoffTriggerEligible(err: unknown): err is ProviderExhaustedError {
  return (
    err instanceof ProviderExhaustedError &&
    (err.classification === "FAILOVER" ||
      (err.classification === "TRANSIENT" && err.status !== undefined))
  );
}

// ─── Circuit breaker (in-memory, tenant×provider) ─────────

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_WINDOW_MS = 5 * 60_000;
const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

interface CircuitState {
  /** Timestamps of recent failures (pruned to the rolling window). */
  failures: number[];
  /** Circuit is open (provider skipped) until this epoch-ms. */
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();

function circuitKey(tenantId: string | undefined, provider: AIProviderType): string {
  return `${tenantId ?? "global"}:${provider}`;
}

/** Record a provider failure; opens the circuit on the 3rd failure within
 * the 5-minute window. FATAL request-shape errors should NOT be recorded —
 * they say nothing about provider health. */
export function recordProviderFailure(
  tenantId: string | undefined,
  provider: AIProviderType,
  now: number = Date.now(),
): void {
  const key = circuitKey(tenantId, provider);
  const state = circuits.get(key) ?? { failures: [], openUntil: 0 };
  state.failures = state.failures.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = now + CIRCUIT_COOLDOWN_MS;
    state.failures = [];
    logger.warn(
      { tenantId, provider, cooldownMs: CIRCUIT_COOLDOWN_MS },
      "Provider circuit breaker OPEN — link will be skipped while alternatives exist",
    );
  }
  circuits.set(key, state);
}

/** A successful call closes the book on past failures. */
export function recordProviderSuccess(
  tenantId: string | undefined,
  provider: AIProviderType,
): void {
  circuits.delete(circuitKey(tenantId, provider));
}

export function isProviderTripped(
  tenantId: string | undefined,
  provider: AIProviderType,
  now: number = Date.now(),
): boolean {
  const state = circuits.get(circuitKey(tenantId, provider));
  return !!state && state.openUntil > now;
}

/** Test/ops helper — wipes all breaker state. */
export function resetProviderCircuits(): void {
  circuits.clear();
}

// ─── Chain building ───────────────────────────────────────

/** trial/system remain type-only compatibility values for older callers. */
export type ProviderChainSource = "byok-default" | "byok-fallback" | "trial" | "system";

export interface ProviderChainLink {
  provider: AIProviderType;
  source: ProviderChainSource;
  /** Ready-to-dial config (API key decrypted). */
  config: AIClientConfig;
}

interface UserAIConfigRow {
  provider: string;
  model: string;
  encryptedApiKey: string | null;
  baseUrl: string | null;
  isDefault: boolean;
  fallbackOrder: number | null;
  allowSystemFallback: boolean;
  createdAt: Date;
}

/** Project a UserAIConfig row into a dialable link without decrypting it.
 * Cloud rows without key material are unusable; corrupt material fails
 * safely only when the validated transport asks the memoized resolver. */
function rowToLink(
  row: UserAIConfigRow,
  tenantId: string,
  source: ProviderChainSource,
): ProviderChainLink | null {
  const provider = row.provider as AIProviderType;
  const isLocal = LOCAL_PROVIDERS.has(provider);
  if (!row.encryptedApiKey && !isLocal) {
    return null; // cloud row without key material can't serve
  }
  const getApiKey = row.encryptedApiKey
    ? createTenantApiKeyResolver(row.encryptedApiKey, tenantId, provider, isLocal)
    : undefined;
  return {
    provider,
    source,
    config: {
      provider,
      model: row.model,
      apiKey: getApiKey ? TENANT_CREDENTIAL_MARKER : "",
      ...(getApiKey ? { getApiKey } : {}),
      baseUrl: row.baseUrl?.trim() || undefined,
    },
  };
}

/**
 * Every usable BYOK link the tenant configured, in deterministic candidate
 * order: default row first, then fallbackOrder members (asc), then the
 * remaining stored keys (createdAt). Superset of the chain's BYOK section —
 * multi-model compare candidates are "the tenant's CONFIGURED providers"
 * (plan §2.5), while chain membership (fallbackOrder set) is a failover
 * concern (§2.2). Never includes trial/system links: compare mode runs
 * exclusively on the tenant's own keys. OFFLINE_MODE strips cloud links,
 * mirroring buildTenantProviderChain.
 */
export async function listTenantProviderLinks(tenantId: string): Promise<ProviderChainLink[]> {
  const rows = (await prisma.userAIConfig.findMany({
    where: { tenantId },
  })) as unknown as UserAIConfigRow[];

  const sorted = [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const ao = a.fallbackOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.fallbackOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const links: ProviderChainLink[] = [];
  sorted.forEach((row, i) => {
    const link = rowToLink(row, tenantId, i === 0 ? "byok-default" : "byok-fallback");
    if (link) links.push(link);
  });

  return env.OFFLINE_MODE === true
    ? links.filter((l) => LOCAL_PROVIDERS.has(l.provider))
    : links;
}

/**
 * Build the tenant's failover chain in the D-009-corrected order (docs at
 * the top of this file). Returns [] when NOTHING may serve — callers turn
 * that into the historical "No AI provider configured" error instead of
 * silently burning the system key (the pre-T7 bleed).
 *
 * OFFLINE_MODE strips every cloud BYOK link — only tenant-owned
 * OLLAMA / LMSTUDIO / CUSTOM survive.
 */
export async function buildTenantProviderChain(tenantId: string): Promise<ProviderChainLink[]> {
  const rows = (await prisma.userAIConfig.findMany({
    where: { tenantId },
  })) as unknown as UserAIConfigRow[];

  const offline = env.OFFLINE_MODE === true;

  // Default row: isDefault first, createdAt tiebreaker — identical
  // semantics to getTenantAIConfig so single-row tenants resolve the same.
  const sorted = [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const defaultRow = sorted[0];

  const links: ProviderChainLink[] = [];
  if (defaultRow) {
    const head = rowToLink(defaultRow, tenantId, "byok-default");
    if (head) links.push(head);
  }
  // Failover links: ONLY rows the tenant explicitly put in the chain
  // (fallbackOrder set — NULL rows are stored keys, not chain members).
  const fallbackRows = sorted
    .filter((r) => r !== defaultRow && r.fallbackOrder !== null)
    .sort((a, b) =>
      a.fallbackOrder! !== b.fallbackOrder!
        ? a.fallbackOrder! - b.fallbackOrder!
        : a.createdAt.getTime() - b.createdAt.getTime(),
    );
  for (const row of fallbackRows) {
    const link = rowToLink(row, tenantId, "byok-fallback");
    if (link) links.push(link);
  }

  const byokLinks = offline
    ? links.filter((l) => LOCAL_PROVIDERS.has(l.provider))
    : links;

  // BR-P0-002-D: allowSystemFallback and system-held environment keys are
  // historical inputs only. Runtime resolution returns tenant-owned BYOK or
  // local links exclusively, even when adversarial fallback flags are set.
  return byokLinks;
}

// ─── D-013: honest single-completion resolution ───────────
//
// buildTenantProviderChain (above) is what the MAIN pipeline/run agent loop
// dials through: tenant BYOK/local default → tenant-owned fallback links →
// nothing (an honest configuration error).
//
// Several one-shot completion call sites (agent composer, run/:id/explain,
// the NL company builder) NEVER went through the chain: they called
// ai-client's getTenantAIConfig() directly, which — by design for its OTHER
// callers (pipeline cost-estimate, Settings "test connection") — falls
// through to the system Anthropic key the instant the tenant has no usable
// BYOK row, with NO regard for plan tier, the allowSystemFallback opt-in,
// OR the counted trial pool. That is fine for a cost estimate or a
// connectivity ping (nothing is spent), but for the composer/explain/
// builder call sites it silently spent the shared system Anthropic credit
// for tenants who should have been metered through the trial pool or told
// to configure a provider (D-013 — the single-completion sibling of D-009).
//
// resolveTenantCompletionLink closes that gap by resolving the HEAD of the
// very same buildTenantProviderChain the run loop uses — so the two can
// never drift. The head is exactly the D-009 policy's first choice (BYOK →
// counted trial → opt-in/PAID system); an empty chain becomes the honest
// "No AI provider configured" error instead of a silent system completion.
// When the head is the trial link, the caller commits the run-based counter
// after the completion succeeds (commitTrialCompletion) — same consume-on-
// serve/refund-on-failure contract runAgentLoop honors.

/**
 * D-013 honest resolver for single-completion surfaces (composer,
 * run/:id/explain, NL company builder). Returns the FIRST link of the
 * tenant's BYOK/local chain, or throws when no tenant-owned provider may
 * serve. It cannot return a trial/system link.
 */
export async function resolveTenantCompletionLink(tenantId: string): Promise<ProviderChainLink> {
  const chain = await buildTenantProviderChain(tenantId);
  const [head] = chain;
  if (!head) {
    throw new Error("No AI provider configured. Please add an API key in Settings → AI Provider.");
  }
  return head;
}

/**
 * Compatibility no-op. Hosted trial completions cannot be produced by this
 * module after BR-P0-002-D.
 */
export async function commitTrialCompletion(
  _tenantId: string,
  _source: ProviderChainSource,
  _usage?: { provider: AIProviderType; model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  return undefined;
}

/**
 * Compatibility no-op paired with commitTrialCompletion.
 */
export async function refundTrialCompletion(
  _tenantId: string,
  _source: ProviderChainSource,
): Promise<void> {
  return undefined;
}
