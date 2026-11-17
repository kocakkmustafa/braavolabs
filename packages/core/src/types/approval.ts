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

/** Yapılandırılmış veri aktarımı: yalnız araç/alan ADLARI ve ham yön değerleri; değer yok. */
export type ApprovalDataTransfer =
  /** `input_fields`: SPEND araç kapısının girdi alanı adları; INPUT (ask_user) onay tipiyle ilgisi YOK. */
  | { kind: "input_fields"; tool: string; fields: string[] }
  | { kind: "external_control"; action?: string; connectionId: string; targetId?: string }
  | { kind: "handoff"; provider: string; model?: string };

export interface ApprovalDetails {
  risk: ApprovalRisk | null;
  /** İstenen yetki/araç kapsamı. */
  permissions: string[] | null;
  /** Hangi veri nereye (alan adları; değer yok). */
  dataTransfer: string[] | null;
  /**
   * BRA-UX-API-07 — `dataTransfer` ile AYNI bilgi, metinsiz (istemci yerelleştirir). Yalnız
   * `dataTransfer` üretilebilen durumda bulunur; yoksa alan hiç yer almaz (eski şekil birebir).
   */
  dataTransferStructured?: ApprovalDataTransfer;
  /** Geri alınabilirlik; bugün hiçbir kaynakta kayıtlı değil → her zaman null. */
  reversible: boolean | null;
}

export interface ApprovalListItemExtras {
  details?: ApprovalDetails;
}
