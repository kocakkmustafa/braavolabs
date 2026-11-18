/**
 * BRA-P0-11b — GET /companies/:id/summary (salt-okur özet; migration yok).
 *
 * Kaynaklar: Agent / Pipeline sayısı, Run kova sayıları (run/job-bucket-query.ts'teki
 * bucketWhere — tek doğruluk kaynağı, kopya yok), bekleyen Approval (Approval → Run →
 * Pipeline.companyId) ve bu ay (UTC) Run.costUsd toplamı. Maliyet kaynağı yoksa
 * (ay içinde maliyeti dolu koşu yok) `monthCostUsd: null`; sayımlar gerçek 0 olabilir.
 *
 * Kiracı kapsamı: şirket router'da {id, tenantId} ile doğrulanır; tüm sayımlar ayrıca
 * pipeline.company.tenantId ile kısıtlanır.
 */
import { INBOX_BUCKETS, type InboxBucket } from "@ai-company-os/core";
import { prisma } from "../../lib/db";
import { bucketWhere, jobStaleAfterMs } from "../run/job-bucket-query";
import { computeBudgetStatus, parseMonthlyBudget, type BudgetStatus } from "./budget";
import { monthStartUtc, toMicro, microToText } from "./models-overview";

export interface CompanySummary {
  companyId: string;
  agents: number;
  pipelines: number;
  buckets: Record<InboxBucket, number>;
  pendingApprovals: number;
  monthCostUsd: string | null;
  /** BRA-P0-11c: Company.config.monthlyBudgetUsd karşısında bu ayın harcaması. */
  budget: BudgetStatus;
}

export async function buildCompanySummary(
  tenantId: string,
  companyId: string,
  now: Date = new Date(),
  companyConfig?: unknown,
): Promise<CompanySummary> {
  const runScope = { pipeline: { companyId, company: { tenantId } } };
  const staleAfterMs = jobStaleAfterMs();
  const from = monthStartUtc(now);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

  const [agents, pipelines, counts, pendingApprovals, cost] = await Promise.all([
    prisma.agent.count({ where: { companyId, company: { tenantId } } }),
    prisma.pipeline.count({ where: { companyId, company: { tenantId } } }),
    Promise.all(
      INBOX_BUCKETS.map((b) =>
        prisma.run.count({ where: { AND: [runScope, bucketWhere(b, now, staleAfterMs)] } }),
      ),
    ),
    prisma.approval.count({ where: { status: "PENDING", run: runScope } }),
    prisma.run.aggregate({
      _sum: { costUsd: true },
      where: { ...runScope, createdAt: { gte: from, lt: to } },
    }),
  ]);

  const buckets = Object.fromEntries(INBOX_BUCKETS.map((b, i) => [b, counts[i]])) as Record<InboxBucket, number>;
  const sum = cost._sum.costUsd;
  const monthCostUsd = sum === null || sum === undefined ? null : microToText(toMicro(sum));
  return {
    companyId,
    agents,
    pipelines,
    buckets,
    pendingApprovals,
    monthCostUsd,
    budget: computeBudgetStatus(parseMonthlyBudget(companyConfig), monthCostUsd === null ? null : Number(monthCostUsd)),
  };
}
