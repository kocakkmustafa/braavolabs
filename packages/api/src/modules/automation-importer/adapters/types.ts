/** Shared types for automation-importer adapters. */

/**
 * A converted step.
 *
 * T0 (E5/plan §T0) aligned this shape to the executor's `StepDef`
 * (`pipeline/executor.ts` — `{ name, agentRole, order, config }`) so an
 * imported pipeline is actually runnable, WITHOUT breaking the live
 * `/preview` UI which reads `id`/`type`. Concretely:
 *   • `id`   / `type`       — PRESERVED for `/preview` back-compat (kabul #8).
 *   • `name` / `agentRole`  — NEW: executor contract (agentRole ∈ {imported_llm,
 *                             imported_operator}, assigned deterministically by
 *                             sourceType — see agent-synthesis.ts).
 *   • `order`               — NEW: monotonically-increasing 0..n for the runner sort.
 *   • `sourceType`          — the ORIGINAL step type (equals `type`); the agent
 *                             synthesis layer reads this to pick a role.
 *
 * Adapters emit the raw `{ id, type, config }` triple (RawStep); the shared
 * `finalizeSteps()` (agent-synthesis.ts) enriches them into this full shape so
 * every adapter is covered uniformly (kabul #9).
 */
export interface ConvertedStep {
  id: string;
  type: string;
  name: string;
  agentRole: string;
  order: number;
  config: unknown;
  sourceType: string;
}

/** What an adapter emits before role/order enrichment. */
export interface RawStep {
  id: string;
  type: string;
  config: unknown;
  /** Optional human label; defaults to a title-cased `type` when absent. */
  name?: string;
}

export interface ConvertedPipeline {
  pipeline: {
    name: string;
    description?: string;
    steps: ConvertedStep[];
  };
  dropped: Array<{ id: string; type: string; reason: string }>;
  warnings: string[];
}
