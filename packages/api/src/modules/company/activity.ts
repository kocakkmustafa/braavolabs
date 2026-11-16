/**
 * BRA-P2-03c — şirket olay günlüğü (salt-okur): `GET /companies/:id/activity`.
 *
 * ActivityLog şirkete resource="company" + resourceId=şirket id'si ile bağlanır (şema: ayrı companyId kolonu YOK;
 * yazıcılar: company.create/update/pause/resume/budget.update/model_mode.update ve members.ts'teki company.member.*).
 * Yalnız bu bağ kullanılır; JSON-path eşitliği yok (SEC-019). Başka kaynaklara (run/agent/pipeline) bakılmaz:
 * onlar kendi uçlarında (`/runs/:id/activity`) görünür.
 *
 * Yanıt: {items:[{id, action, at, actor?, summary}], nextCursor}. Maskeleme run/activity.ts ile ORTAK
 * (safeActor, actionLabel); burada yalnız şirket etiketleri ve allowlist'li ek alanlar farklıdır.
 * Ham `details`, e-posta, ad, gerekçe, sır ASLA yanıta girmez; actor yalnız "system" ya da kimlik biçimli.
 */
import { AppError } from "../../middleware/error";
import { afterCursorWhere, decodeCursor, encodeCursor, LIST_ORDER, parseLimit } from "../run/list-cursor";
import { actionLabel, safeActor, type ActivityItem } from "../run/activity";

export const COMPANY_ACTIVITY_DEFAULT_LIMIT = 50;
export const COMPANY_ACTIVITY_MAX_LIMIT = 100;

export const COMPANY_ACTION_LABELS: Readonly<Record<string, string>> = {
  "company.create": "Company created",
  "company.update": "Company updated",
  "company.pause": "Company paused",
  "company.resume": "Company resumed",
  "company.archive": "Company archived",
  "company.budget.update": "Budget updated",
  "company.model_mode.update": "Model mode updated",
  "company.member.add": "Member added",
  "company.member.remove": "Member removed",
  "company.member.role_update": "Member role changed",
  "company.member.owner_transferred": "Ownership transferred",
  "company.owner_orphaned": "Company left without owner",
};

const ROLES = new Set(["OWNER", "ADMIN", "MEMBER"]);
const role = (v: unknown): string | null => (typeof v === "string" && ROLES.has(v) ? v.toLowerCase() : null);
const ACTION_SAFE = /^[a-z][a-z0-9_.]{0,47}$/;

/** Sabit etiket + yalnız rol enum'larından türetilmiş ekler; başka `details` alanı okunmaz. */
export function summarizeCompany(action: unknown, details: unknown): string {
  const base =
    typeof action === "string" && Object.prototype.hasOwnProperty.call(COMPANY_ACTION_LABELS, action)
      ? COMPANY_ACTION_LABELS[action]
      : actionLabel(action);
  const parts: string[] = [];
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    const from = role(d.from), to = role(d.to), r = role(d.role);
    if (from && to) parts.push(`${from} → ${to}`);
    else if (r) parts.push(`role ${r}`);
  }
  return [base, ...parts].join(" · ");
}

interface Row { id: string; action: string; actor: string; details: unknown; createdAt: Date }

export function toCompanyActivityItem(r: Row): ActivityItem {
  const actor = safeActor(r.actor);
  return {
    id: r.id,
    action: typeof r.action === "string" && ACTION_SAFE.test(r.action) ? r.action : "unknown",
    at: r.createdAt.toISOString(),
    ...(actor ? { actor } : {}),
    summary: summarizeCompany(r.action, r.details),
  };
}

export interface CompanyActivityDb {
  company: { findFirst(args: any): Promise<any> };
  activityLog: { findMany(args: any): Promise<any> };
}

export async function loadCompanyActivity(
  db: CompanyActivityDb,
  input: { tenantId: string; companyId: string; limitRaw: unknown; cursorRaw: unknown },
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  const limit = parseLimit(input.limitRaw, COMPANY_ACTIVITY_DEFAULT_LIMIT, COMPANY_ACTIVITY_MAX_LIMIT);
  if (limit === null) throw new AppError(400, `Invalid limit. Use an integer between 1 and ${COMPANY_ACTIVITY_MAX_LIMIT}.`);
  const cursor = input.cursorRaw === undefined ? undefined : decodeCursor(input.cursorRaw);
  if (cursor === null) throw new AppError(400, "Invalid cursor.");

  const { tenantId, companyId } = input;
  const company = await db.company.findFirst({ where: { id: companyId, tenantId }, select: { id: true } });
  if (!company) throw new AppError(404, "Company not found");

  const rows = await db.activityLog.findMany({
    where: { AND: [{ tenantId }, { resource: "company", resourceId: company.id }, ...(cursor ? [afterCursorWhere(cursor)] : [])] },
    select: { id: true, action: true, actor: true, details: true, createdAt: true },
    orderBy: LIST_ORDER,
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { items: page.map(toCompanyActivityItem), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}
