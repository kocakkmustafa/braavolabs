import type { AIProviderType } from "./ai-client";
import { REASONING_EFFORT_CAPABILITIES } from "./reasoning-effort";

/**
 * Per-agent effort planning (AI company design, docs/ai-company/TASARIM.tr.md §5.4).
 *
 * An agent carries one provider-neutral effort level. This module turns it into
 * the exact provider wire field for one provider/model/endpoint — or refuses.
 * It is a pure planner: nothing here is wired into chatCompletion yet, so the
 * live request path (and the Cerebras-only `reasoningEffort` option) is
 * unchanged until the agent loop adopts it.
 *
 * Same rule as reasoning-effort.ts: exact positive profiles only. A model name
 * that merely looks compatible, a proxy base URL, or a provider whose docs do
 * not give a per-model accepted set gets no profile and therefore no effort
 * field (the provider default applies). Sources, read 2026-10-31:
 *   Anthropic: Messages API `output_config.effort` (GA, no beta header) — Claude
 *     API reference, thinking & effort table (cached 2026-10-06).
 *   Groq: https://console.groq.com/docs/reasoning (`reasoning_effort`).
 *   Cerebras: existing REASONING_EFFORT_CAPABILITIES profile.
 * Not profiled (doğrulanamadı): OpenAI — https://developers.openai.com/api/docs/guides/reasoning
 *   lists values but defers per-model accepted sets to model pages; Google — the
 *   thinking guide documents `thinking_level` for a surface other than the
 *   generateContent adapter used here.
 */

/** Provider-neutral effort an agent can carry. */
export type AgentEffort = "none" | "low" | "medium" | "high" | "max";
export const AGENT_EFFORTS: readonly AgentEffort[] = Object.freeze(["none", "low", "medium", "high", "max"]);

/** Provider-side effort values that appear in at least one profile, ordered weakest → strongest. */
const PROVIDER_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;
type ProviderEffort = (typeof PROVIDER_ORDER)[number];

type Transport = "anthropic-messages" | "chat-completions";

interface EffortProfile {
  provider: AIProviderType;
  models: readonly string[];
  baseUrl: string;
  transport: Transport;
  efforts: readonly ProviderEffort[];
  /** Thinking cannot be switched off; "none" degrades to the lowest level. */
  alwaysReasons: boolean;
}

const ANTHROPIC = "https://api.anthropic.com";
const GROQ = "https://api.groq.com/openai/v1";
const FIVE: readonly ProviderEffort[] = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export const AGENT_EFFORT_PROFILES: readonly EffortProfile[] = Object.freeze([
  // Anthropic — output_config.effort. Opus 5.5 / Fable 5.x / Sonnet 5.5 reject disabling thinking.
  { provider: "ANTHROPIC", models: ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5"], baseUrl: ANTHROPIC, transport: "anthropic-messages", efforts: FIVE, alwaysReasons: true },
  { provider: "ANTHROPIC", models: ["claude-sonnet-5-5"], baseUrl: ANTHROPIC, transport: "anthropic-messages", efforts: FIVE, alwaysReasons: true },
  { provider: "ANTHROPIC", models: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-haiku-5-5"], baseUrl: ANTHROPIC, transport: "anthropic-messages", efforts: FIVE, alwaysReasons: false },
  { provider: "ANTHROPIC", models: ["claude-opus-4-6", "claude-sonnet-4-6"], baseUrl: ANTHROPIC, transport: "anthropic-messages", efforts: Object.freeze(["low", "medium", "high", "max"] as const), alwaysReasons: false },
  // Groq — reasoning_effort on the OpenAI-compatible endpoint.
  { provider: "GROQ", models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"], baseUrl: GROQ, transport: "chat-completions", efforts: Object.freeze(["low", "medium", "high"] as const), alwaysReasons: true },
  { provider: "GROQ", models: ["qwen/qwen3.8-27b"], baseUrl: GROQ, transport: "chat-completions", efforts: Object.freeze(["none", "low", "medium", "high"] as const), alwaysReasons: false },
  { provider: "GROQ", models: ["meta-models/muse-spark-open"], baseUrl: GROQ, transport: "chat-completions", efforts: Object.freeze(["low", "medium", "high", "xhigh"] as const), alwaysReasons: true },
  // Cerebras — mirror the existing exact profile so both planners agree.
  ...REASONING_EFFORT_CAPABILITIES.map(p => ({
    provider: p.provider as AIProviderType, models: [p.model], baseUrl: p.baseUrl, transport: "chat-completions" as const,
    efforts: p.efforts as readonly ProviderEffort[], alwaysReasons: true,
  })),
]);

export type AgentEffortPlan =
  | {
      status: "applied";
      requested: AgentEffort;
      providerEffort: ProviderEffort;
      /** Fields to merge into the provider request body. */
      wire: { output_config: { effort: ProviderEffort } } | { reasoning_effort: ProviderEffort };
      /** True when the requested level was mapped to the nearest level the model accepts. */
      adjusted: boolean;
    }
  | { status: "unsupported"; requested: AgentEffort; reason: "unknown-effort" | "no-profile" | "endpoint-mismatch" };

const TARGET: Record<AgentEffort, ProviderEffort> = { none: "none", low: "low", medium: "medium", high: "high", max: "max" };

function nearestSupported(target: ProviderEffort, efforts: readonly ProviderEffort[]): ProviderEffort {
  if (efforts.includes(target)) return target;
  const rank = PROVIDER_ORDER.indexOf(target);
  // Prefer the closest weaker level (never spend more than asked); fall back to the weakest available.
  for (let i = rank - 1; i >= 0; i--) if (efforts.includes(PROVIDER_ORDER[i])) return PROVIDER_ORDER[i];
  return efforts[0];
}

/**
 * Plan the effort field for one exact provider/model/endpoint.
 * "none" on a model that always reasons maps to its weakest level (adjusted: true);
 * "max" on a model without max maps to its strongest level below it.
 */
export function planAgentEffort(
  config: { provider: AIProviderType; model: string; baseUrl?: string },
  effort: unknown,
): AgentEffortPlan {
  if (typeof effort !== "string" || !(AGENT_EFFORTS as readonly string[]).includes(effort)) {
    return { status: "unsupported", requested: effort as AgentEffort, reason: "unknown-effort" };
  }
  const requested = effort as AgentEffort;
  const profile = AGENT_EFFORT_PROFILES.find(p => p.provider === config.provider && p.models.includes(config.model));
  if (!profile) return { status: "unsupported", requested, reason: "no-profile" };
  const baseUrl = (config.baseUrl?.trim() || profile.baseUrl).replace(/\/+$/, "");
  if (baseUrl !== profile.baseUrl) return { status: "unsupported", requested, reason: "endpoint-mismatch" };

  const target = TARGET[requested];
  const providerEffort = target === "none" && !profile.efforts.includes("none")
    ? profile.efforts[0]
    : nearestSupported(target, profile.efforts);
  const wire = profile.transport === "anthropic-messages"
    ? { output_config: { effort: providerEffort } }
    : { reasoning_effort: providerEffort };
  return { status: "applied", requested, providerEffort, wire, adjusted: providerEffort !== target };
}

/** Efforts an agent can meaningfully choose for this model (for pickers); empty when unprofiled. */
export function agentEffortsFor(config: { provider: AIProviderType; model: string; baseUrl?: string }): readonly AgentEffort[] {
  return AGENT_EFFORTS.filter(e => {
    const plan = planAgentEffort(config, e);
    return plan.status === "applied" && !plan.adjusted;
  });
}
