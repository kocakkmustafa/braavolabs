/**
 * BRA-P1-06-N3 — GET /companies/:id/budget/projects (salt-okur; migration yok).
 *
 * "Proje" = pipeline (kurucu 2026-11-18). Bu ay (UTC) Run.costUsd pipeline bazında toplanır;
 * şirket aylık limiti (Company.config.monthlyBudgetUsd) yalnız şirket düzeyindedir, proje
 * bazlı limit yoktur. Para hesabı mikro-USD BigInt (summary/models-overview ile aynı yardımcılar).
 * Bu ay koşusu olmayan pipeline listelenmez. Okuma erişimi /summary ile aynı (router-wide authMiddleware).
 */
import { prisma } from "../../lib/db";
import { computeBudgetStatus, parseMonthlyBudget, type BudgetStatus } from "./budget";
import { monthStartUtc, toMicro, microToText } from "./models-overview";

export const MAX_BUDGET_PROJECTS = 200;

export interface ProjectBudgetRow {
  pipelineId: string;
  name: string;
  runCount: number;
  spentUsd: string | null;
  sharePct: number | null;
  lastRunAt: string | null;
}

export interface ProjectBudgetView {
  companyId: string;
  month: string;
  budget: BudgetStatus;
  totalSpentUsd: string | null;
  projects: ProjectBudgetRow[];
  truncated?: true;
}

/** Pipeline başına ham toplama satırı (groupBy çıktısının sadeleştirilmişi). */
export interface PipelineRunGroup {
  pipelineId: string;
  runCount: number;
  /** Decimal/string/number ya da hiç maliyetli koşu yoksa null. */
  costSum: unknown;
  lastRunAt: Date | null;
}

/** Saf: gruplar + adlar -> sıralı, oranlı, sınırlı satırlar. DB/IO yok. */
export function aggregateProjects(
  groups: PipelineRunGroup[],
  names: Map<string, string>,
  limit: number = MAX_BUDGET_PROJECTS,
): { totalSpentUsd: string | null; projects: ProjectBudgetRow[]; truncated: boolean } {
  let totalMicro = 0n;
  let anyCost = false;
  const rows = groups.map((g) => {
    const has = g.costSum !== null && g.costSum !== undefined;
    const micro = has ? toMicro(g.costSum) : 0n;
    if (has) {
      totalMicro += micro;
      anyCost = true;
    }
    return { g, has, micro, name: names.get(g.pipelineId) ?? "" };
  });

  rows.sort((a, b) => {
    if (a.micro !== b.micro) return a.micro > b.micro ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.g.pipelineId < b.g.pipelineId ? -1 : a.g.pipelineId > b.g.pipelineId ? 1 : 0;
  });

  const projects: ProjectBudgetRow[] = rows.slice(0, limit).map(({ g, has, micro, name }) => ({
    pipelineId: g.pipelineId,
    name,
    runCount: g.runCount,
    spentUsd: has ? microToText(micro) : null,
    // yüzde*100 = micro*10000/total, tam sayı bölme (aşağı); toplam 0 ise null
    sharePct: has && totalMicro > 0n ? Number((micro * 10_000n) / totalMicro) / 100 : null,
    lastRunAt: g.lastRunAt ? g.lastRunAt.toISOString() : null,
  }));

  return {
    totalSpentUsd: anyCost ? microToText(totalMicro) : null,
    projects,
    truncated: rows.length > limit,
  };
}

export async function buildProjectBudget(
  tenantId: string,
  companyId: string,
  companyConfig: unknown,
  now: Date = new Date(),
): Promise<ProjectBudgetView> {
  const from = monthStartUtc(now);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const month = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`;

  // Tek groupBy (N+1 yok); kiracı kapsamı summary.ts ile aynı.
  const grouped = await prisma.run.groupBy({
    by: ["pipelineId"],
    where: { pipeline: { companyId, company: { tenantId } }, createdAt: { gte: from, lt: to } },
    _count: { _all: true },
    _sum: { costUsd: true },
    _max: { createdAt: true },
  });
  const pipelines = grouped.length
    ? await prisma.pipeline.findMany({
        where: { id: { in: grouped.map((g) => g.pipelineId) }, companyId, company: { tenantId } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(pipelines.map((p) => [p.id, p.name] as [string, string]));

  const agg = aggregateProjects(
    grouped.map((g) => ({
      pipelineId: g.pipelineId,
      runCount: g._count._all,
      costSum: g._sum.costUsd,
      lastRunAt: g._max.createdAt,
    })),
    names,
  );

  return {
    companyId,
    month,
    budget: computeBudgetStatus(
      parseMonthlyBudget(companyConfig),
      agg.totalSpentUsd === null ? null : Number(agg.totalSpentUsd),
    ),
    totalSpentUsd: agg.totalSpentUsd,
    projects: agg.projects,
    ...(agg.truncated ? { truncated: true as const } : {}),
  };
}
