export type ApprovalType = "SPEND";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export interface CreateApprovalInput {
  runId: string;
  type: ApprovalType;
  description: string;
  amountUsd?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string;
}

/**
 * BRA-UX-API-01 — GET /approvals yanıtındaki OPSİYONEL ek alan (eski istemciler kırılmaz).
 * Kapalı şema; kaynak olmayan alan null döner (bkz. DECISIONS.md ADR-0003 BRA-UX-API-01 notu).
 */
export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalDetails {
  risk: ApprovalRisk | null;
  /** İstenen yetki/araç kapsamı. */
  permissions: string[] | null;
  /** Hangi veri nereye (alan adları; değer yok). */
  dataTransfer: string[] | null;
  /** Geri alınabilirlik; bugün hiçbir kaynakta kayıtlı değil → her zaman null. */
  reversible: boolean | null;
}

export interface ApprovalListItemExtras {
  details?: ApprovalDetails;
}
