/**
 * QA-BRA-01 — REST liste sözleşmesi (tek kaynak: mobil/masaüstü tüketicilerin bağlandığı şekil).
 * Yalnız test tarafında yaşar; üretim kodu değişmez. `docs/openapi-draft.yaml` bu şemalarla
 * rest-contract.test.ts içinde karşılaştırılır; gerçek router yanıtları da bu şemalarla doğrulanır.
 */
import { z } from "zod";

/** CORS `exposedHeaders` ile aynı olmalı (src/lib/cors.ts). */
export const NEXT_CURSOR_HEADER = "X-Next-Cursor";
export const INBOX_BUCKET_VALUES = ["working", "needs_approval", "done", "stuck"] as const;
export const APPROVAL_STATUS_VALUES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;
export const LIMIT_DEFAULT = 25;

/** AppError / Zod / bilinen çerçeve hataları / 500 — hepsinde `error` metni var. */
export const ErrorBodySchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
  code: z.string().optional(),
  requestId: z.string().optional(),
});

const nullableString = z.string().nullable();

export const RunListItemSchema = z.object({
  id: z.string(),
  pipelineId: z.string(),
  status: z.string(),
  state: nullableString,
  resultStatus: nullableString,
  trigger: z.string(),
  /** Prisma Decimal JSON'da string olarak gider. */
  costUsd: nullableString,
  startedAt: nullableString,
  completedAt: nullableString,
  heartbeatAt: nullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
  pipeline: z.object({
    id: z.string(),
    name: z.string(),
    company: z.object({ id: z.string(), name: z.string() }),
  }),
  bucket: z.enum(INBOX_BUCKET_VALUES).nullable(),
});

/** GET /api/v1/runs */
export const RunsListResponseSchema = z.object({
  runs: z.array(RunListItemSchema),
  nextCursor: nullableString,
});

/** Onay satırı: tüketicilerin okuduğu çekirdek alanlar; sunucu ek alan (artifact, run...) ekleyebilir. */
export const ApprovalItemSchema = z.looseObject({
  id: z.string(),
  runId: z.string(),
  type: z.string(),
  status: z.enum(APPROVAL_STATUS_VALUES),
  metadata: z.object({ toolName: z.string().optional() }),
  createdAt: z.string(),
});

/** GET /api/v1/approvals — gövde düz dizi; (sayfalıysa) imleç X-Next-Cursor başlığında. */
export const ApprovalsArrayResponseSchema = z.array(ApprovalItemSchema);

/** GET /api/v1/approvals?groupBy=run — imleç gövdede. */
export const ApprovalsGroupedResponseSchema = z.object({
  groups: z.array(z.object({
    runId: z.string(),
    runTitle: nullableString,
    approvals: z.array(z.looseObject({ id: z.string(), runId: z.string() })),
  })),
  nextCursor: nullableString,
});

export const COMPONENT_SCHEMAS = {
  ErrorBody: ErrorBodySchema,
  RunListItem: RunListItemSchema,
  RunsListResponse: RunsListResponseSchema,
  ApprovalItem: ApprovalItemSchema,
  ApprovalsGroupedResponse: ApprovalsGroupedResponseSchema,
} as const;

/** GET /approvals öğesinin TAM anahtar kümesi (sızıntı kapısı: yeni alan bilinçli eklenmeli). */
export const APPROVAL_ITEM_KEYS = [
  "id", "runId", "type", "status", "description", "amountUsd", "metadata", "decidedBy", "decidedAt",
  "expiresAt", "createdAt", "run", "artifact", "details",
] as const;
/** run.pipeline.company: config yalnız allowlist (toPublicCompany) — webhookSecret asla gövdede değil. */
export const APPROVAL_COMPANY_KEYS = ["id", "name", "slug", "config"] as const;
