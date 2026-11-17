/**
 * BRA-UX-API-04 — GET /runs satırı için salt-okur özet alanları (saf yardımcı).
 *
 *  agentName  koşunun ilk (en düşük stepIndex) ajanlı adımının ajan adı. Run'ın kendi ajan
 *             alanı yok; kaynak RunStep.agentId → Agent.name. Ajanlı adım yoksa null (uydurma yok).
 *  riskLevel  koşunun onay satırlarından en yüksek risk (high > medium > low); approval/details.ts
 *             sınıflarını (deriveApprovalDetails/asRisk) yeniden kullanır. Veri yoksa null.
 *
 * Yalnız ad + enum döner; ham metadata/içerik asla çıkmaz. Sorgu router'daki findMany'nin
 * iç içe select'idir (ek tur yok, N+1 yok).
 */
import { deriveApprovalDetails, type ApprovalRisk } from "../approval/details";

/** Satır başına taranan onay üst sınırı (sayfa boyutuyla birlikte sorguyu sınırlar). */
export const MAX_ROW_APPROVALS = 50;

/** findMany `select`'ine eklenen iç içe parçalar; tenant kapsamı agent→company üzerinden de dayatılır. */
export function rowSummarySelect(tenantId: string) {
  return {
    steps: {
      where: { agentId: { not: null }, agent: { company: { tenantId } } },
      orderBy: { stepIndex: "asc" as const },
      take: 1,
      select: { agent: { select: { name: true } } },
    },
    approvals: {
      take: MAX_ROW_APPROVALS,
      select: { type: true, metadata: true },
    },
  };
}

const RANK: Record<ApprovalRisk, number> = { low: 1, medium: 2, high: 3 };

export function highestRisk(approvals: ReadonlyArray<{ type?: unknown; metadata: unknown }> | null | undefined): ApprovalRisk | null {
  let best: ApprovalRisk | null = null;
  for (const a of approvals ?? []) {
    const r = deriveApprovalDetails(a.type, a.metadata).risk;
    if (r && (best === null || RANK[r] > RANK[best])) best = r;
  }
  return best;
}

export function agentNameOf(steps: ReadonlyArray<{ agent?: { name?: unknown } | null }> | null | undefined): string | null {
  const n = steps?.[0]?.agent?.name;
  return typeof n === "string" && n.length > 0 ? n : null;
}

/** Ham satırdan steps/approvals'ı ayırır, yerine agentName + riskLevel koyar. */
export function withRowSummary<T extends { steps?: any; approvals?: any }>(
  row: T,
): Omit<T, "steps" | "approvals"> & { agentName: string | null; riskLevel: ApprovalRisk | null } {
  const { steps, approvals, ...rest } = row;
  return { ...rest, agentName: agentNameOf(steps), riskLevel: highestRisk(approvals) };
}
