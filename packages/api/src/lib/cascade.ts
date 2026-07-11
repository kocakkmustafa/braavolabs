/**
 * Cascade / triage-first orchestration (Forge P3 §4).
 *
 * Answer with the CHEAPEST capable model; escalate to a higher tier only when
 * the answer's confidence is below threshold — or when the caller explicitly
 * asks for a second opinion. Pure orchestration over an INJECTED runner: zero
 * network / secrets, fully unit-testable. Composes routeTask + escalate from
 * routing.ts, so the "cheapest-capable, escalate-on-low-confidence" policy is
 * one tested code path (not re-derived per call site).
 *
 * The runner returns a confidence in [0,1]; HOW that confidence is produced
 * (model self-report vs a heuristic) is the wiring layer's choice — this
 * orchestrator only consumes it, keeping it deterministic and testable.
 */

import { ModelSpec, RouteRequest, routeTask, escalate } from "./routing";

export interface CascadeRunResult {
  answer: string;
  /** [0,1] — self-reported or heuristic; the cascade only compares it to the threshold. */
  confidence: number;
  costUsd: number;
}

export type CascadeRunner = (model: ModelSpec, req: RouteRequest) => Promise<CascadeRunResult>;

export interface CascadeOptions {
  /** Escalate while confidence < this. Default 0.7. */
  confidenceThreshold?: number;
  /** Force at least one escalation past the first answer (explicit "second opinion"). */
  secondOpinion?: boolean;
  /** Hard cap on cumulative USD; stop escalating once total ≥ cap. */
  budgetUsdCap?: number;
  /** Max models to try (safety bound). Default = models.length. */
  maxAttempts?: number;
}

export interface CascadeAttempt {
  model: ModelSpec;
  answer: string;
  confidence: number;
  costUsd: number;
}

export type CascadeStop = "confident" | "frontier-reached" | "budget-cap" | "max-attempts";

export interface CascadeResult {
  answer: string;
  model: ModelSpec;
  confidence: number;
  attempts: CascadeAttempt[];
  escalated: boolean;
  totalCostUsd: number;
  stoppedReason: CascadeStop;
  rationale: string;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export async function runCascade(
  req: RouteRequest,
  models: ModelSpec[],
  run: CascadeRunner,
  opts: CascadeOptions = {},
): Promise<CascadeResult> {
  const threshold = opts.confidenceThreshold ?? 0.7;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? models.length);
  const attempts: CascadeAttempt[] = [];

  // First pick: cheapest capable model (routeTask honors req.hard → frontier start).
  let current = routeTask(req, models).model;
  let totalCostUsd = 0;
  let stoppedReason: CascadeStop = "confident";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await run(current, req);
    attempts.push({ model: current, answer: r.answer, confidence: r.confidence, costUsd: r.costUsd });
    totalCostUsd = round(totalCostUsd + r.costUsd);

    const confident = r.confidence >= threshold;
    // Force exactly one escalation past the first answer when a second opinion is requested.
    const forceEscalate = opts.secondOpinion === true && attempts.length === 1;

    if (confident && !forceEscalate) {
      stoppedReason = "confident";
      break;
    }
    // No higher-tier model left → we exhausted the cascade (this beats the
    // artificial max-attempts bound, which only fires while a higher model exists).
    const next = escalate(current, req, models);
    if (!next) {
      stoppedReason = "frontier-reached";
      break;
    }
    if (opts.budgetUsdCap !== undefined && totalCostUsd >= opts.budgetUsdCap) {
      stoppedReason = "budget-cap";
      break;
    }
    if (attempts.length >= maxAttempts) {
      stoppedReason = "max-attempts";
      break;
    }
    current = next.model;
  }

  // Best answer = highest confidence (ties break toward the later / higher-tier attempt).
  const best = attempts.reduce((a, b) => (b.confidence >= a.confidence ? b : a));
  const escalated = attempts.length > 1;

  return {
    answer: best.answer,
    model: best.model,
    confidence: best.confidence,
    attempts,
    escalated,
    totalCostUsd,
    stoppedReason,
    rationale: escalated
      ? `cascade: ${attempts.map((a) => `${a.model.tier}/${a.model.id}(${a.confidence.toFixed(2)})`).join(" → ")} [${stoppedReason}]`
      : `cascade: ${best.model.tier}/${best.model.id} confident (${best.confidence.toFixed(2)}), no escalation`,
  };
}
