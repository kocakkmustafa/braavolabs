/**
 * Agent synthesis + step finalization for the automation importer.
 *
 * BACKGROUND (E5/plan §T1, findings E5-IMP-01/02/03): the importer used to
 * write a "pipeline shell" — the converted node graph went into
 * `Pipeline.config.converted` while `Pipeline.steps` stayed `[]` and NO Agent
 * rows were created. A run of such a pipeline either silently COMPLETEd (empty
 * steps) or FAILED in the executor with "workspace has no agents yet". This
 * module closes that gap with two pure, unit-testable functions:
 *
 *   • finalizeSteps(raw)      — enrich adapter `{id,type,config}` into the full
 *                               executor-compatible step shape, assigning a
 *                               deterministic `agentRole` and monotonic `order`.
 *   • deriveAgentsFromSteps() — synthesize the company-scope Agents the steps
 *                               reference (FIXED 2 roles), returning the agent
 *                               specs the persist layer idempotently creates.
 *
 * DECISION (Açık Soru #1, BINDING): FIXED 2 ROLES per import —
 *   • imported_llm       — LLM / prompt steps.
 *   • imported_operator  — tool / http / mcp / script / branch / transform steps.
 * Deterministic, covers all 5 adapters (kabul #9), and every synthesized
 * `step.agentRole` EXACT-matches one of these two Agent roles (kabul #2).
 */

import type { ConvertedStep, RawStep } from "./adapters/types";

export const IMPORTED_LLM_ROLE = "imported_llm";
export const IMPORTED_OPERATOR_ROLE = "imported_operator";

/**
 * Source-step types that map to the LLM role. Everything else (http, tool,
 * mcp.invoke, script, branch, transform, and any unknown type) maps to the
 * operator role — the safe default (an operator agent has generic tool-running
 * behaviour, not free-form generation).
 */
const LLM_SOURCE_TYPES = new Set<string>(["llm", "prompt", "claude-routine-step"]);

/** Deterministically pick the fixed role for a given source step type. */
export function roleForSourceType(sourceType: string): string {
  return LLM_SOURCE_TYPES.has(sourceType) ? IMPORTED_LLM_ROLE : IMPORTED_OPERATOR_ROLE;
}

/** Title-case a step type into a human-readable default name. */
function labelForType(type: string): string {
  const cleaned = type.replace(/[._-]+/g, " ").trim();
  if (!cleaned) return "Imported step";
  return cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Enrich adapter raw steps into executor-compatible ConvertedSteps.
 * - `order` is the array index (0..n monotonic) so runner.ts's `.sort((a,b)=>
 *   a.order-b.order)` is stable and grouping is correct.
 * - `agentRole` is assigned by `roleForSourceType` (exact-match to a synthesized
 *   Agent role — kabul #2).
 * - `id`/`type` are PRESERVED for `/preview` back-compat (kabul #8).
 * - `sourceType` records the original type for the agent-synthesis reader.
 */
export function finalizeSteps(raw: RawStep[]): ConvertedStep[] {
  return raw.map((s, idx) => ({
    id: s.id,
    type: s.type,
    name: s.name && s.name.trim().length > 0 ? s.name.trim() : labelForType(s.type),
    agentRole: roleForSourceType(s.type),
    order: idx,
    config: s.config,
    sourceType: s.type,
  }));
}

export interface SynthesizedAgentSpec {
  name: string;
  role: string;
  systemPrompt: string;
}

const AGENT_SPEC_BY_ROLE: Record<string, SynthesizedAgentSpec> = {
  [IMPORTED_LLM_ROLE]: {
    name: "Imported LLM Agent",
    role: IMPORTED_LLM_ROLE,
    systemPrompt:
      "You are an imported LLM/prompt worker. Execute the instructions carried in this step's " +
      "configuration (system/user prompt or routine body) faithfully and return the requested " +
      "output. Always explain your reasoning before acting.",
  },
  [IMPORTED_OPERATOR_ROLE]: {
    name: "Imported Operator Agent",
    role: IMPORTED_OPERATOR_ROLE,
    systemPrompt:
      "You are an imported operator worker responsible for tool/HTTP/MCP-style actions described " +
      "in this step's configuration. Perform the intended action using the tools available to you, " +
      "respect approval gates, and explain your reasoning before acting.",
  },
};

/**
 * Given the finalized steps, return the DISTINCT Agent specs they reference
 * (at most 2 — the fixed roles). The persist layer creates any that don't yet
 * exist in the company (findFirst→create; upsert is impossible — Agent has no
 * @@unique on (companyId, role) — see kabul #2 / adversarial A2).
 *
 * Also returns `agentRoleByStepIndex` for assertion/debugging; the step's own
 * `agentRole` field is authoritative for the executor.
 */
export function deriveAgentsFromSteps(steps: ConvertedStep[]): {
  agents: SynthesizedAgentSpec[];
  agentRoleByStepIndex: string[];
} {
  const roles = new Set<string>();
  const agentRoleByStepIndex: string[] = [];
  for (const s of steps) {
    roles.add(s.agentRole);
    agentRoleByStepIndex.push(s.agentRole);
  }
  const agents = Array.from(roles).map((r) => AGENT_SPEC_BY_ROLE[r]).filter(Boolean);
  return { agents, agentRoleByStepIndex };
}
