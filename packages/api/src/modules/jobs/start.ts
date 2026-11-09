/**
 * BRA-P0-03b — plan kartı onayıyla iş başlatma: minimal koşu yaratıcısı.
 *
 * `pipeline/router.ts` route'a gömülü olduğu için (refactor gerektirir) aynı
 * Prisma alanlarıyla yeniden yazıldı: Pipeline (MANUAL, SEQUENTIAL) + Run
 * (tenantId/workspaceId/jobBudget/idempotencyKey). Burada HİÇBİR onay/yetki
 * kaydı üretilmez: yüksek riskli adımlar yürütücüdeki mevcut onay kapısında
 * kalır (config.needsApproval yalnız bilgi taşır).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/db";
import { JobBudgetSchema, type JobBudget } from "../run/job-budget";
import type { PlanCard } from "./plan";

/** Fiyatsız modelde (kartta maxUsd yok) uygulanan güvenli USD tavanı. */
export const DEFAULT_MAX_USD = 1;

/** Başlatılan her koşunun USD tavanı vardır; kart vermediyse güvenli varsayılan. */
export function resolveStartBudget(card: PlanCard): JobBudget {
  const b = card.budget;
  return JobBudgetSchema.parse({ ...b, maxUsd: b.maxUsd !== undefined ? b.maxUsd : DEFAULT_MAX_USD });
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

/** Pipeline + PENDING Run yazar. Run benzersizlik ihlalinde pipeline geri alınır ve hata yeniden fırlatılır. */
export async function createPlannedRun(input: StartRunInput): Promise<StartedRun> {
  const { card } = input;
  const steps = card.steps.map((s, i) => ({
    name: s.title,
    agentRole: input.agentRole,
    order: i,
    config: { planned: true, tool: s.tool ?? null, risk: s.risk, needsApproval: s.needsApproval },
  }));
  const pipeline = await prisma.pipeline.create({
    data: {
      companyId: input.workspaceId,
      name: card.title.slice(0, 80),
      trigger: "MANUAL",
      pipelineType: "SEQUENTIAL",
      steps: steps as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  try {
    const run = await prisma.run.create({
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
  } catch (err) {
    await prisma.pipeline.delete({ where: { id: pipeline.id } }).catch(() => undefined);
    throw err;
  }
}
