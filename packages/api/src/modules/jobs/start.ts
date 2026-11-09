/**
 * BRA-P0-03b — plan kartı onayıyla iş başlatma: minimal koşu yaratıcısı.
 *
 * `pipeline/router.ts` route'a gömülü olduğu için (refactor gerektirir) aynı
 * Prisma alanlarıyla yeniden yazıldı: Pipeline (MANUAL, SEQUENTIAL) + Run
 * (tenantId/workspaceId/jobBudget/idempotencyKey), tek tenantTx içinde.
 *
 * ÖNEMLİ: `config.needsApproval` yürütücüde ZORLANMAZ; yalnız LLM istemine
 * giden bilgi metnidir. Gerçek onay kapısı araç meta'sı/ajan autonomy'sidir.
 * Bu yüzden `risk:"high"` ya da `needsApproval` adımı olan kartlar router'da
 * 422 ile reddedilir (BRA-P0-03d: adım-düzeyi onay kapısı bağlanana kadar).
 * Burada hiçbir onay/yetki kaydı üretilmez.
 */
import type { Prisma } from "@prisma/client";
import { tenantTx } from "../../lib/db";
import { JobBudgetSchema, type JobBudget } from "../run/job-budget";
import type { PlanCard } from "./plan";

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
    // Yalnız bilgi: yürütücü bunu zorlamaz.
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
