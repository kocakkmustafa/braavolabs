/**
 * BRA-P0-03b — plan kartı onayıyla iş başlatma: minimal koşu yaratıcısı.
 *
 * `pipeline/router.ts` route'a gömülü olduğu için (refactor gerektirir) aynı
 * Prisma alanlarıyla yeniden yazıldı: Pipeline (MANUAL, SEQUENTIAL) + Run
 * (tenantId/workspaceId/jobBudget/idempotencyKey), tek tenantTx içinde.
 *
 * ÖNEMLİ: `config.needsApproval` yürütücüde YALNIZ `STEP_APPROVAL_GATE=true`
 * iken zorlanır (BRA-P0-03d, pipeline/step-approval.ts); kapalıyken yalnız LLM
 * istemine giden bilgi metnidir. Bu yüzden `risk:"high"` ya da `needsApproval`
 * adımı olan kartlar kapı kapalıyken router'da 422 ile reddedilir
 * (`canStartCard`). Burada hiçbir onay/yetki kaydı üretilmez: kapı açıkken
 * koşu normal kuyruğa girer, onay satırını yürütücü ilgili adımdan ÖNCE açar.
 */
import type { Prisma } from "@prisma/client";
import { tenantTx } from "../../lib/db";
import { JobBudgetSchema, type JobBudget } from "../run/job-budget";
import type { PlanCard } from "./plan";
import { isStepApprovalGateEnabled, stepRequiresApproval } from "../pipeline/step-approval";

/** Karttan gelmeyen boyutlar için güvenli varsayılan tavanlar. */
export const DEFAULT_MAX_USD = 1;
export const DEFAULT_MAX_TOKENS = 200_000;
export const DEFAULT_MAX_STEPS = 10;
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Başlatılan her koşunun USD, token, adım ve süre tavanı vardır. Kart bir değer
 * verdiyse korunur. Fiyatsız modelde USD ölçümü 0 çıkabileceğinden token tavanı
 * ayrıca zorunludur.
 */
export function resolveStartBudget(card: PlanCard): JobBudget {
  const b = card.budget;
  return JobBudgetSchema.parse({
    ...b,
    maxUsd: b.maxUsd ?? DEFAULT_MAX_USD,
    maxTokens: b.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: b.maxSteps ?? DEFAULT_MAX_STEPS,
    timeoutMs: b.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/** Yüksek riskli kart (başlatma kapalı): risk high ya da onay isteyen adım var. */
export function isHighRiskCard(card: PlanCard): boolean {
  return card.risk === "high" || card.steps.some((s) => s.needsApproval);
}

/**
 * Kart başlatılabilir mi? Yüksek riskli olmayan kart her zaman; yüksek riskli kart
 * yalnız adım-düzeyi onay kapısı AÇIKKEN ve kartta kapıyı tetikleyecek en az bir
 * işaretli adım varken (aksi halde risk işareti yürütücüde karşılıksız kalırdı).
 */
export function canStartCard(card: PlanCard, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isHighRiskCard(card)) return true;
  if (!isStepApprovalGateEnabled(env)) return false;
  return card.steps.some((s) => stepRequiresApproval({ needsApproval: s.needsApproval, risk: s.risk }));
}

export interface StartRunInput {
  tenantId: string;
  workspaceId: string;
  agentRole: string;
  card: PlanCard;
  planHash: string;
  idempotencyKey: string;
  /** USD tavanı dahil (resolveStartBudget çıktısı). */
  budget: JobBudget;
}

export interface StartedRun {
  runId: string;
  pipelineId: string;
  state: string;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** Pipeline + PENDING Run tek işlemde yazılır; hata olursa ikisi de geri alınır (yetim pipeline kalmaz). Kuyruğa alma çağıranındır (commit sonrası). */
export async function createPlannedRun(input: StartRunInput): Promise<StartedRun> {
  const { card } = input;
  const steps = card.steps.map((s, i) => ({
    name: s.title,
    agentRole: input.agentRole,
    order: i,
    // STEP_APPROVAL_GATE açıkken yürütücü bunu zorlar (step-approval.ts); kapalıyken yalnız bilgi.
    config: { planned: true, tool: s.tool ?? null, risk: s.risk, needsApproval: s.needsApproval },
  }));
  return tenantTx(async (tx) => {
    const pipeline = await tx.pipeline.create({
      data: {
        companyId: input.workspaceId,
        name: card.title.slice(0, 80),
        trigger: "MANUAL",
        pipelineType: "SEQUENTIAL",
        steps: steps as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const run = await tx.run.create({
      data: {
        pipelineId: pipeline.id,
        status: "PENDING",
        trigger: "manual",
        input: { source: "jobs/start", planHash: input.planHash, untrustedGoal: card.goal } as Prisma.InputJsonValue,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        jobBudget: input.budget as Prisma.InputJsonValue,
      },
      select: { id: true, status: true },
    });
    return { runId: run.id, pipelineId: pipeline.id, state: run.status };
  });
}
