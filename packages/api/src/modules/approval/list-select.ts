/**
 * BRA-P0-04h — GET /approvals için dar yanıt yüzeyi (veri minimizasyonu).
 *
 * Eskiden `include: run → pipeline → company` ham `run.input/output/error`,
 * `pipeline.steps` ve tüm Approval sütunlarını (nonce, actionHash, tenantId,
 * consumedAt …) döndürüyordu. İstemcilerin okuduğu alanlar (web approvals /
 * dashboard / NotificationBell, mobil approvals + ana sayfa) şunlardır:
 *   onay    : id, type, status, description, amountUsd, createdAt, runId,
 *             artifact, metadata.toolName
 *   ilişki  : run.pipeline.company.name (web kartı), run.pipeline.name (groupBy)
 * Geri kalan her şey çıkar; `metadata` yalnız `toolName`e indirilir (`input`,
 * `note`, `handoffId` … dışarı çıkmaz; artifact sunucuda ham metadata'dan çıkarılır).
 */

export const APPROVAL_LIST_SELECT = {
  id: true,
  runId: true,
  type: true,
  status: true,
  description: true,
  amountUsd: true,
  metadata: true, // yalnız sunucu içi (artifact çıkarımı); yanıta sızmaz → projectApprovalRow
  decidedBy: true,
  decidedAt: true,
  expiresAt: true,
  createdAt: true,
  run: {
    select: {
      id: true,
      pipeline: {
        select: {
          id: true,
          name: true,
          company: { select: { id: true, name: true, slug: true, config: true } },
        },
      },
    },
  },
} as const;

/** Yanıta çıkan metadata: yalnız `toolName` (dashboard ikon/başlık). */
export function publicApprovalMetadata(metadata: unknown): { toolName?: string } {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const t = (metadata as Record<string, unknown>).toolName;
    if (typeof t === "string") return { toolName: t };
  }
  return {};
}

/** Ham metadata'yı dar hâle indirir; diğer alanlar olduğu gibi kalır. */
export function projectApprovalRow<T extends { metadata: unknown }>(row: T): Omit<T, "metadata"> & { metadata: { toolName?: string } } {
  return { ...row, metadata: publicApprovalMetadata(row.metadata) };
}
