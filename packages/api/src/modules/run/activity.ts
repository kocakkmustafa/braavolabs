/**
 * BRA-P2-05 — koşu olay günlüğü (salt-okur): `GET /runs/:id/activity`.
 *
 * ActivityLog koşuya üç yoldan bağlanır (şema: resource + resourceId; ayrı runId kolonu YOK):
 *   - resource "run"      + resourceId = koşu id'si (stop/resume/retry/handoff/steer/delivery/…),
 *   - resource "run_step" + resourceId = adım id'si (rollback/rerun),
 *   - resource "approval" + resourceId = onay id'si (karar/süre aşımı/tüketim),
 *   - BİLİNEN BOŞLUK: adım kapısının "approval.requested" kaydı (pipeline/step-approval.ts) resourceId taşımaz (koşu id'si yalnız
 *     details.runId'de); agent/tool-executor.ts'teki "approval.requested" ise resource "tool_call" ve runId'siz. Bunlar listede YOK:
 *     JSON-path eşitliğini destekleyen (tenant_id, action, created_at) indeksi yok ve SEC-019 bu deseni bilerek kaldırmıştı.
 *     Kalıcı çözüm: yazıcıya resourceId=approvalId (ayrı bilet adayı). Onayın kararı/süre aşımı/tüketimi yine görünür.
 *
 * Yanıt kalemi: {id, action, at, actor?, summary}. `summary` SABİT BİÇİMLİ: eylem → sabit İngilizce etiket + yalnız
 * allowlist'li alanlardan (tamsayı/enum/bool) türetilmiş ekler. Ham `details`, gerekçe, hata metni, araç çıktısı,
 * e-posta/token/sır, kullanıcı içeriği ASLA girmez. `actor` yalnız "system" ya da kimlik biçimli userId/agentId.
 */
import { AppError } from "../../middleware/error";
import { afterCursorWhere, decodeCursor, encodeCursor, LIST_ORDER, parseLimit } from "./list-cursor";

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 100;
/** Koşu başına bağlanan adım/onay id'si üst sınırı (IN listesi sınırlı kalır). */
export const ACTIVITY_MAX_LINKED_IDS = 500;

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  "run.owner.assign": "Owner assigned",
  "run.delivery.approve": "Delivery approved",
  "run.explain": "Failure explained",
  "run.stop": "Run stopped",
  "run.resume": "Run resumed",
  "run.retry": "Run retried",
  "run.steer": "Steering message sent",
  "run.chat.send": "Chat message sent",
  "run.handoff_requested": "Handoff requested",
  "run.handoff_created": "Handoff created",
  "run.handoff_claimed": "Handoff claimed",
  "run.handoff_cancelled": "Handoff cancelled",
  "run.pending_orphaned": "Run marked orphaned",
  "run.pending_requeued": "Run requeued",
  "run.hierarchical_failed": "Run failed",
  "run.hierarchical_completed": "Run completed",
  "run_step.rollback": "Step rolled back",
  "run_step.rerun": "Step rerun",
  "approval.requested": "Approval requested",
  "approval.approved": "Approval approved",
  "approval.rejected": "Approval rejected",
  "approval.expired": "Approval expired",
  "approval.consumed": "Approval used",
  "approval.closed_by_continue": "Approval closed by continue",
};

const RESULTS: Readonly<Record<string, string>> = {
  COMPLETED: "completed", FAILED: "failed", CANCELLED: "cancelled", SKIPPED: "skipped", RUNNING: "running", PENDING: "pending",
};
const ACTION_SAFE = /^[a-z][a-z0-9_.]{0,47}$/;
const ACTOR_SAFE = /^[A-Za-z0-9-]{8,40}$/;
const ACTOR_SECRETISH = /^(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abprs])-/i;
const MAX_INT = 9999;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_INT;

/** Eylem etiketi: bilinen → sabit etiket; bilinmeyen ama kod-biçimli → "Event (action)"; aksi hâlde "Event". */
export function actionLabel(action: unknown): string {
  if (typeof action !== "string") return "Event";
  if (Object.prototype.hasOwnProperty.call(ACTION_LABELS, action)) return ACTION_LABELS[action];
  return ACTION_SAFE.test(action) ? `Event (${action})` : "Event";
}

/** Yalnız allowlist'li alanlardan ek parçalar; başka hiçbir `details` alanı okunmaz. */
export function summarize(action: unknown, details: unknown): string {
  const parts: string[] = [];
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    if (isInt(d.stepIndex)) parts.push(`step ${d.stepIndex + 1}`);
    if (isInt(d.retryCount)) parts.push(`attempt ${d.retryCount}`);
    if (d.gate === "step") parts.push("step gate");
    if (d.cause === "job_budget") parts.push("budget limit");
    if (d.runCancelled === true) parts.push("run cancelled");
    if (typeof d.result === "string" && Object.prototype.hasOwnProperty.call(RESULTS, d.result)) parts.push(`result ${RESULTS[d.result]}`);
  }
  return [actionLabel(action), ...parts].join(" · ");
}

/** "system" ya da kimlik biçimli (e-posta/ad/token-benzeri DEĞİL) actor; aksi hâlde yok. */
export function safeActor(actor: unknown): string | undefined {
  if (actor === "system") return "system";
  if (typeof actor !== "string" || !ACTOR_SAFE.test(actor) || ACTOR_SECRETISH.test(actor)) return undefined;
  return actor;
}

export interface ActivityItem { id: string; action: string; at: string; actor?: string; summary: string }
/** truncated: koşunun adım/onay sayısı ACTIVITY_MAX_LINKED_IDS'i aştı; bazı olaylar listelenmedi. */
export interface ActivityPage { items: ActivityItem[]; nextCursor: string | null; truncated: boolean }

interface ActivityRow { id: string; action: string; actor: string; details: unknown; createdAt: Date }

export function toActivityItem(r: ActivityRow): ActivityItem {
  const actor = safeActor(r.actor);
  return {
    id: r.id,
    action: typeof r.action === "string" && ACTION_SAFE.test(r.action) ? r.action : "unknown",
    at: r.createdAt.toISOString(),
    ...(actor ? { actor } : {}),
    summary: summarize(r.action, r.details),
  };
}

/** Prisma'nın bu işte kullanılan dar yüzü (test için taklit edilebilir). */
export interface ActivityDb {
  run: { findFirst(args: any): Promise<any> };
  activityLog: { findMany(args: any): Promise<any> };
}

export async function loadRunActivity(
  db: ActivityDb,
  input: { tenantId: string; runId: string; limitRaw: unknown; cursorRaw: unknown },
): Promise<ActivityPage> {
  const limit = parseLimit(input.limitRaw, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT);
  if (limit === null) throw new AppError(400, `Invalid limit. Use an integer between 1 and ${ACTIVITY_MAX_LIMIT}.`);
  const cursor = input.cursorRaw === undefined ? undefined : decodeCursor(input.cursorRaw);
  if (cursor === null) throw new AppError(400, "Invalid cursor.");

  const { tenantId, runId } = input;
  const run = await db.run.findFirst({
    where: { id: runId, pipeline: { company: { tenantId } } },
    select: {
      id: true,
      steps: { select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: ACTIVITY_MAX_LINKED_IDS + 1 },
      approvals: { select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: ACTIVITY_MAX_LINKED_IDS + 1 },
    },
  });
  if (!run) throw new AppError(404, "Run not found");

  const truncated = run.steps.length > ACTIVITY_MAX_LINKED_IDS || run.approvals.length > ACTIVITY_MAX_LINKED_IDS;
  const stepIds = run.steps.slice(0, ACTIVITY_MAX_LINKED_IDS).map((s: { id: string }) => s.id);
  const approvalIds = run.approvals.slice(0, ACTIVITY_MAX_LINKED_IDS).map((a: { id: string }) => a.id);
  const links: unknown[] = [
    { resource: "run", resourceId: run.id },
  ];
  if (stepIds.length) links.push({ resource: "run_step", resourceId: { in: stepIds } });
  if (approvalIds.length) links.push({ resource: "approval", resourceId: { in: approvalIds } });

  const rows = await db.activityLog.findMany({
    where: { AND: [{ tenantId }, { OR: links }, ...(cursor ? [afterCursorWhere(cursor)] : [])] },
    select: { id: true, action: true, actor: true, details: true, createdAt: true },
    orderBy: LIST_ORDER,
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map(toActivityItem),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    truncated,
  };
}
