/**
 * BRA-P0-08 — Job budget (ADR-0002).
 *
 * A per-run ceiling on USD, tokens, steps, wall-clock time and retries. Pure
 * evaluation: no I/O, no clock reads (callers pass `usage`), so it is cheap to
 * test and shared by every enforcement point.
 *
 * Shared contract with the CLI daemon budget (`cli/src/daemon/budget.ts`):
 *   - same warning threshold (`WARN_AT = 0.8`) → `JOB_BUDGET_WARN_RATIO`
 *   - same "used up" rule: ratio >= 1 stops (a limit of 0 is already used up)
 *   - USD is the same unit; priced spend only (this module never guesses)
 * The CLI budget is monthly per agent/company; this one is per job. They are
 * different scopes with one vocabulary, so a future runner can sum both.
 *
 * Semantics:
 *   - An omitted limit means "no limit on that dimension". A run with no
 *     budget at all (`NULL`) keeps today's behaviour.
 *   - A MALFORMED stored budget is fail-closed: `parseJobBudget` reports it and
 *     the enforcement point stops the run instead of running unbounded.
 *   - `maxRetries` stops only when retries used EXCEED the cap (a run that used
 *     exactly its allowance may still finish); every other dimension stops at
 *     ratio >= 1, i.e. BEFORE one more step could overshoot.
 */
import { z } from "zod";

/** Same as the CLI `WARN_AT`. */
export const JOB_BUDGET_WARN_RATIO = 0.8;

export const JobBudgetSchema = z
  .object({
    maxUsd: z.number().finite().nonnegative().optional(),
    maxTokens: z.number().int().nonnegative().optional(),
    maxSteps: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    warnRatio: z.number().gt(0).lt(1).default(JOB_BUDGET_WARN_RATIO),
  })
  .strict();

export type JobBudget = z.infer<typeof JobBudgetSchema>;

export interface JobUsage {
  usd: number;
  tokens: number;
  steps: number;
  elapsedMs: number;
  retries: number;
}

export type BudgetDimension = "usd" | "tokens" | "steps" | "time" | "retries";
export type BudgetLevel = "ok" | "warn" | "stop";

export interface DimensionVerdict {
  dimension: BudgetDimension;
  used: number;
  limit: number;
  ratio: number;
  level: BudgetLevel;
}

export interface BudgetVerdict {
  action: BudgetLevel;
  dimensions: DimensionVerdict[];
  /** Dimensions at "stop", in evaluation order. */
  stopped: BudgetDimension[];
  /** Human reason for the run's error/activity log; null unless action === "stop". */
  reason: string | null;
}

/** `null`/`undefined` → no budget. Anything else must match the schema or it is invalid (fail-closed). */
export function parseJobBudget(
  raw: unknown,
): { ok: true; budget: JobBudget | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, budget: null };
  const parsed = JobBudgetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "budget"}: ${i.message}`).join("; ") };
  }
  return { ok: true, budget: parsed.data };
}

function ratioOf(used: number, limit: number): number {
  if (limit > 0) return used / limit;
  return used > 0 ? Infinity : limit === 0 ? Infinity : 0;
}

/** Evaluate usage against a budget. Pure. */
export function evaluateJobBudget(budget: JobBudget, usage: JobUsage): BudgetVerdict {
  const warnAt = budget.warnRatio ?? JOB_BUDGET_WARN_RATIO;
  const dimensions: DimensionVerdict[] = [];

  const add = (dimension: BudgetDimension, used: number, limit: number | undefined) => {
    if (limit === undefined) return;
    const ratio = ratioOf(used, limit);
    // Retries are an allowance: only going past the cap stops the run.
    const stopHere = dimension === "retries" ? used > limit : ratio >= 1;
    // A zero retry allowance with nothing used yet is not a warning.
    const warnHere = dimension === "retries" ? limit > 0 && ratio >= warnAt : ratio >= warnAt;
    const level: BudgetLevel = stopHere ? "stop" : warnHere ? "warn" : "ok";
    dimensions.push({ dimension, used, limit, ratio, level });
  };

  add("usd", usage.usd, budget.maxUsd);
  add("tokens", usage.tokens, budget.maxTokens);
  add("steps", usage.steps, budget.maxSteps);
  add("time", usage.elapsedMs, budget.timeoutMs);
  add("retries", usage.retries, budget.maxRetries);

  const stopped = dimensions.filter((d) => d.level === "stop").map((d) => d.dimension);
  const action: BudgetLevel = stopped.length > 0 ? "stop" : dimensions.some((d) => d.level === "warn") ? "warn" : "ok";
  const reason =
    action === "stop"
      ? `Job budget exhausted (${dimensions
          .filter((d) => d.level === "stop")
          .map((d) => `${d.dimension}: ${d.used} of ${d.limit}`)
          .join("; ")})`
      : null;
  return { action, dimensions, stopped, reason };
}

/**
 * Tenant / workspace gate: the run's denormalised owner (`runs.tenant_id`,
 * `runs.workspace_id`, NULL on pre-migration rows) must agree with the owner
 * derived through Pipeline → Company. NULL = not backfilled yet → no opinion;
 * a present-but-different value is a hard stop (fail-closed).
 */
export function checkJobScope(args: {
  runTenantId: string | null | undefined;
  ownerTenantId: string;
  runWorkspaceId: string | null | undefined;
  ownerWorkspaceId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (args.runTenantId && args.runTenantId !== args.ownerTenantId) {
    return { ok: false, reason: "Job scope mismatch: run tenant differs from its owner" };
  }
  if (args.runWorkspaceId && args.runWorkspaceId !== args.ownerWorkspaceId) {
    return { ok: false, reason: "Job scope mismatch: run workspace differs from its owner" };
  }
  return { ok: true };
}

/** Sum prompt + completion tokens over steps; NULL token columns count as 0 (unmetered, never guessed). */
export function sumStepTokens(
  steps: ReadonlyArray<{ promptTokens?: number | null; completionTokens?: number | null }>,
): number {
  let total = 0;
  for (const s of steps) total += (s.promptTokens ?? 0) + (s.completionTokens ?? 0);
  return total;
}
