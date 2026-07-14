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
 *        BYOK default row → tenant's other rows with fallbackOrder (asc) →
 *        trial Groq (FREE plan, counted) → system Anthropic (OPT-IN only)
 *
 *      Privacy rule (plan §2.2, binding): auto-failover only ever walks
 *      providers the TENANT configured. Falling to the trial pool / system
 *      Anthropic when the tenant HAS BYOK rows requires the explicit
 *      allowSystemFallback flag on the default row (default false). A
 *      tenant with NO BYOK at all enters through trial-Groq when on the
 *      FREE plan (counted — closes the D-009 uncounted-system-key bleed);
 *      BYOK-less PAID tenants keep the system entry (deliberate: they pay
 *      for the platform, and cutting them over would brick every paying
 *      tenant that hasn't configured BYOK yet — the D-009 bleed was FREE).
 *
 *      Failover is default-OFF end to end: fresh rows have
 *      fallbackOrder=NULL (not part of the chain) and
 *      allowSystemFallback=false, so a newly configured tenant gets exactly
 *      one link = today's static behaviour.
 */

import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { decryptForTenant } from "../lib/encryption";
import { tryConsumeTrialRun, commitTrialRun } from "./trial-llm";
import {
  LOCAL_PROVIDERS,
  ToolsUnsupportedError,
  chatCompletion,
  type AIClientConfig,
  type AIProviderType,
  type ChatMessage,
  type ChatCompletionResult,
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
  constructor(
    /** classifyProviderError verdict on the final chain link's error. */
    public readonly classification: ProviderErrorClass,
    /** HTTP status when extractStatus recovered one (undefined = default-
     * TRANSIENT guess — NOT handoff-eligible, see isHandoffTriggerEligible). */
    public readonly status: number | undefined,
    /** Provider/model of the LAST link that failed (handoff fromProvider). */
    public readonly provider: AIProviderType,
    public readonly model: string,
    /** The original provider error. */
    public readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "ProviderExhaustedError";
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

/** Decrypt a UserAIConfig row into a dialable link. Cloud rows whose key
 * is missing or won't decrypt are unusable and return null (same D-002
 * reasoning as getTenantAIConfig — apiKey:"" would just 401); local
 * providers legitimately run keyless. */
function rowToLink(
  row: UserAIConfigRow,
  tenantId: string,
  source: ProviderChainSource,
): ProviderChainLink | null {
  const provider = row.provider as AIProviderType;
  const isLocal = LOCAL_PROVIDERS.has(provider);
  let apiKey = "";
  if (row.encryptedApiKey) {
    try {
      apiKey = decryptForTenant(row.encryptedApiKey, tenantId);
    } catch (err) {
      if (!isLocal) {
        logger.warn(
          { tenantId, provider, err: (err as Error).message },
          "Chain link skipped — tenant AI key failed to decrypt (cloud provider cannot run keyless)",
        );
        return null;
      }
      // Local provider with an undecryptable optional token: run keyless.
    }
  } else if (!isLocal) {
    return null; // cloud row without key material can't serve
  }
  return {
    provider,
    source,
    config: {
      provider,
      model: row.model,
      apiKey,
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
 * OFFLINE_MODE strips every cloud link (trial + system included) — only
 * OLLAMA / LMSTUDIO / CUSTOM survive, mirroring chatCompletion's guard.
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

  const hasByok = rows.length > 0; // configured INTENT, even if rows are unusable
  const allowSystemFallback = defaultRow?.allowSystemFallback === true;

  // Trial + system links are CLOUD links — never under OFFLINE_MODE.
  if (offline) return byokLinks;

  const chain = [...byokLinks];

  // Trial Groq — entry path for BYOK-less FREE tenants (counted; closes
  // D-009), and an opt-in tail link for BYOK tenants. tryConsumeTrialRun
  // does the eligibility work (FREE plan + counter + holding key present)
  // WITHOUT mutating the counter — the loop commits only after a
  // trial-served run succeeds.
  if (!hasByok || allowSystemFallback) {
    const trial = await tryConsumeTrialRun(tenantId);
    if (trial) {
      chain.push({ provider: "GROQ", source: "trial", config: trial.config });
    }
  }

  // System Anthropic — strictly opt-in for BYOK tenants (privacy rule);
  // entry path only for BYOK-less PAID tenants (see module docs). A
  // missing tenant row is treated as FREE (fail-closed — no system key).
  if (env.ANTHROPIC_API_KEY) {
    let systemAllowed = false;
    if (hasByok) {
      systemAllowed = allowSystemFallback;
    } else {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true },
      });
      systemAllowed = !!tenant && tenant.plan !== "FREE";
    }
    if (systemAllowed) {
      chain.push({
        provider: "ANTHROPIC",
        source: "system",
        config: {
          provider: "ANTHROPIC",
          model: env.CLAUDE_MODEL,
          apiKey: env.ANTHROPIC_API_KEY,
        },
      });
    }
  }

  return chain;
}

// ─── D-013: honest single-completion resolution ───────────
//
// buildTenantProviderChain (above) is what the MAIN pipeline/run agent loop
// dials through (claude.ts runAgentLoop) — it enforces the D-009 privacy
// rule: BYOK default → tenant fallbackOrder links → counted trial Groq
// (FREE) → opt-in/PAID system Anthropic → (nothing ⇒ honest error).
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
 * tenant's D-009 provider chain — BYOK default → counted trial (FREE) →
 * opt-in/PAID system Anthropic — or throws the historical "No AI provider
 * configured" error when NOTHING may serve (BYOK-less FREE with a spent
 * trial, an unusable-key tenant that never opted into system fallback,
 * etc.). Single source of truth with runAgentLoop: it dials this exact
 * chain, so a keyless tenant can never silently reach the system wallet
 * here while being blocked there.
 *
 * When the returned link's `source === "trial"`, the caller MUST call
 * commitTrialCompletion(tenantId, source) AFTER the completion SUCCEEDS
 * (and must NOT on failure — a thrown chatCompletion refunds the slot).
 */
export async function resolveTenantCompletionLink(tenantId: string): Promise<ProviderChainLink> {
  const [head] = await buildTenantProviderChain(tenantId);
  if (!head) {
    throw new Error("No AI provider configured. Please add an API key in Settings → AI Provider.");
  }
  return head;
}

/**
 * Commit the run-based trial counter for a single completion that was served
 * by the trial link — the same contract runAgentLoop applies: consume on
 * serve, and because a failed completion throws before reaching this call,
 * the slot is refunded on failure. No-op for every other source. Counter
 * misses are non-fatal (trial-llm already documents ±1 tolerance).
 */
export async function commitTrialCompletion(
  tenantId: string,
  source: ProviderChainSource,
): Promise<void> {
  if (source !== "trial") return;
  try {
    await commitTrialRun(tenantId);
  } catch (err) {
    logger.warn(
      { tenantId, err: (err as Error).message },
      "commitTrialRun failed after a trial-served single completion (non-fatal)",
    );
  }
}
