/**
 * BRA-P0-03c — POST /jobs/plan ve /jobs/start yanıt ayrıştırıcıları. SAF ve core-RUNTIME-bağımsız
 * (lib/api.ts herkese açık sayfaların yüklediği zincirde; `@ai-company-os/core` değeri import EDİLMEZ).
 * Alanlar API'deki PlanCard şemasının (`api/src/modules/jobs/plan.ts`) alt kümesidir; uydurma alan yok.
 */
export type PlanRisk = "low" | "medium" | "high";
export interface PlanStepView { title: string; tool?: string; needsApproval: boolean; risk: PlanRisk }
export interface PlanCardView {
  title: string;
  goal: string;
  steps: PlanStepView[];
  risk: PlanRisk;
  estimate: { costUsd: { low: number | null; high: number | null }; priced: boolean };
}
export type PlanResponse =
  | { intent: "chat" }
  | { intent: "job"; card: PlanCardView; planHash: string };
export interface StartResponse { runId: string; pipelineId?: string; state?: string }

export class PlanShapeError extends Error {
  constructor(what: string) { super(`Unexpected ${what} response shape`); this.name = "PlanShapeError"; }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isRisk = (v: unknown): v is PlanRisk => v === "low" || v === "medium" || v === "high";
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parsePlanResponse(raw: unknown): PlanResponse {
  if (!isObj(raw)) throw new PlanShapeError("plan");
  if (raw.intent === "chat") return { intent: "chat" };
  if (raw.intent !== "job" || !isObj(raw.card) || typeof raw.planHash !== "string" || !raw.planHash) throw new PlanShapeError("plan");
  const c = raw.card;
  if (typeof c.title !== "string" || typeof c.goal !== "string" || !isRisk(c.risk) || !Array.isArray(c.steps) || c.steps.length === 0) {
    throw new PlanShapeError("plan");
  }
  const steps: PlanStepView[] = c.steps.map((s) => {
    if (!isObj(s) || typeof s.title !== "string" || !isRisk(s.risk) || typeof s.needsApproval !== "boolean") throw new PlanShapeError("plan");
    return { title: s.title, tool: typeof s.tool === "string" ? s.tool : undefined, needsApproval: s.needsApproval, risk: s.risk };
  });
  const est = isObj(c.estimate) ? c.estimate : {};
  const cost = isObj(est.costUsd) ? est.costUsd : {};
  return {
    intent: "job",
    planHash: raw.planHash,
    card: {
      title: c.title, goal: c.goal, steps, risk: c.risk,
      estimate: { costUsd: { low: numOrNull(cost.low), high: numOrNull(cost.high) }, priced: est.priced === true },
    },
  };
}

export function parseStartResponse(raw: unknown): StartResponse {
  if (!isObj(raw) || typeof raw.runId !== "string" || !raw.runId) throw new PlanShapeError("start");
  return { runId: raw.runId, pipelineId: typeof raw.pipelineId === "string" ? raw.pipelineId : undefined, state: typeof raw.state === "string" ? raw.state : undefined };
}
