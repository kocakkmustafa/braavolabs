/**
 * BRA-UX-API-04 — GET /runs satırı için salt-okur özet alanları (saf yardımcı).
 *
 *  agentName  en düşük stepIndex'li AJANLI adımın ajanı (çok ajanlı koşuda yalnız o). Run'ın kendi
 *             ajan alanı yok; kaynak RunStep.agentId → Agent.name. Ajanlı adım yoksa null (uydurma yok).
 *  riskLevel  koşunun EN SON N (MAX_ROW_APPROVALS) onayındaki en yüksek risk (high > medium > low);
 *             APPROVED/REJECTED/EXPIRED dahil — "bekleyen risk" DEĞİL. approval/details.ts'in
 *             deriveApprovalRisk'ini kullanır (yalnız risk; diğer süzgeçler çalışmaz). Veri yoksa null.
 *
 * Yalnız ad + enum döner; ham metadata/içerik asla çıkmaz. Sorgu router'daki findMany'nin
 * iç içe select'idir (ek tur yok, N+1 yok).
 */
import { deriveApprovalRisk, type ApprovalRisk } from "../approval/details";

/** Satır başına taranan EN SON onay sayısı (Prisma iç içe take bellekte kırpar; küçük tutulur). */
export const MAX_ROW_APPROVALS = 20;

/** findMany `select`'ine eklenen iç içe parçalar; tenant kapsamı agent→company üzerinden de dayatılır. */
export function rowSummarySelect(tenantId: string) {
  return {
    steps: {
      where: { agentId: { not: null }, agent: { company: { tenantId } } },
      orderBy: [{ stepIndex: "asc" as const }, { id: "asc" as const }], // stepIndex benzersiz değil
      take: 1,
      select: { agent: { select: { name: true } } },
    },
    approvals: {
      orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
      take: MAX_ROW_APPROVALS,
      select: { type: true, metadata: true },
    },
  };
}

const RANK: Record<ApprovalRisk, number> = { low: 1, medium: 2, high: 3 };

export function highestRisk(approvals: ReadonlyArray<{ type?: unknown; metadata: unknown }> | null | undefined): ApprovalRisk | null {
  let best: ApprovalRisk | null = null;
  for (const a of approvals ?? []) {
    const r = deriveApprovalRisk(a.type, a.metadata);
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
