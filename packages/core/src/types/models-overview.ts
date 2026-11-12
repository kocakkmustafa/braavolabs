/**
 * BRA-UX-API-02 — GET /companies/:companyId/models yanıt şekli (salt-okur).
 * Kaynak olmayan alan `null` döner; sır/anahtar/uç adresi asla yer almaz.
 * Ayrıntı: docs/yula-execution/DECISIONS.md "BRA-UX-API-02 notu".
 */
export type ModelSource = "platform" | "byok" | "local";
export type ModelAccessScope = "company" | "workspace" | "agent";
export type ModelAccessMode = "read" | "read_write";

export interface ModelAccess {
  scope: ModelAccessScope | null;
  mode: ModelAccessMode | null;
}

export interface ModelOverviewItem {
  id: string;
  provider: string | null;
  displayName?: string;
  source: ModelSource | null;
  access: ModelAccess;
  /** Ondalık METİN (6 hane); bu ay, UTC; kaynak veri yoksa null. */
  costThisMonthUsd: string | null;
  runCountThisMonth: number | null;
}

export interface ModelsOverview {
  autoSelection: { enabled: boolean | null };
  models: ModelOverviewItem[];
  generatedAt: string;
  costWindow: { from: string; to: string };
}
