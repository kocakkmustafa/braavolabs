/**
 * BRA-UX-04 — prototip için SAF görünüm mantığı (I/O yok, DOM yok; vitest ile doğrudan test edilir).
 * İlke (04-design.md §5.4, §8): kaynak alan yoksa "bilgi yok" yazılır, uydurulmaz; toplu onay KAPALI;
 * tehlikeli (para ya da geri alınamaz ya da yüksek risk) onay ikinci adım ister.
 */
import type { ApprovalDetails, InboxBucket } from "@ai-company-os/core";
import type { InboxApproval, InboxApprovalGroup, InboxRun } from "../inbox";

/** Liste ucu (PR #133) `details` ekler; yoksa alanlar "bilgi yok" olur. */
export type LabApproval = InboxApproval & { details?: ApprovalDetails | null };
export type LabApprovalGroup = Omit<InboxApprovalGroup, "approvals"> & { approvals: LabApproval[] };

export type FactKey = "what" | "tool" | "permissions" | "data" | "amount" | "reversible" | "risk" | "draft";
/** `value === null` → kaynak yok: arayüz "bilgi yok" der. */
export interface Fact { key: FactKey; value: string | null }

const toNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const joined = (list: string[] | null | undefined): string | null => (list && list.length > 0 ? list.join(", ") : null);

export function usd(n: number, locale = "tr-TR"): string {
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n); } catch { return `$${n}`; }
}

/** Onay anlama (T4): ne yapacak / hangi araç / yetki / veri / tutar / geri alma / taslak. */
export function approvalFacts(a: LabApproval): Fact[] {
  const d = a.details ?? null;
  const amount = toNumber(a.amountUsd);
  return [
    { key: "what", value: a.description?.trim() || null },
    { key: "tool", value: a.metadata?.toolName?.trim() || null },
    { key: "permissions", value: joined(d?.permissions) },
    { key: "data", value: joined(d?.dataTransfer) },
    { key: "amount", value: amount !== null && amount > 0 ? usd(amount) : "—" },
    { key: "reversible", value: d?.reversible === true ? "yes" : d?.reversible === false ? "no" : null },
    { key: "risk", value: d?.risk ?? null },
    { key: "draft", value: a.artifact?.body ? a.artifact.body : null },
  ];
}

export function approvalIsDangerous(a: LabApproval): boolean {
  const amount = toNumber(a.amountUsd);
  return (amount !== null && amount > 0) || a.details?.risk === "high" || a.details?.reversible === false;
}

export const CONFIRM_PHRASE = "Onaylıyorum";
const norm = (s: string) => s.trim().toLocaleLowerCase("tr-TR");
/** Tehlikeli onayın ikinci adımı: ifade birebir (büyük/küçük harf duyarsız) + dolu sebep. Reddetmek ikinci adım istemez. */
export function confirmOk(input: { phrase: string; reason: string }): boolean {
  return norm(input.phrase) === norm(CONFIRM_PHRASE) && input.reason.trim().length >= 3;
}

/** Toplu onay KAPALI (§5.4): "düşük risk" etiketi bugün tam güvenilir değil (03b(b)); her onay tek tek kararlanır. */
export const BATCH_APPROVE_ENABLED = false;

export type BucketMap = Record<InboxBucket, InboxRun[]>;
export function groupRuns(runs: readonly InboxRun[]): BucketMap {
  const out: BucketMap = { working: [], needs_approval: [], done: [], stuck: [] };
  for (const r of runs) if (r.bucket && out[r.bucket]) out[r.bucket].push(r);
  return out;
}

export interface Expected { approvals: number; stuck: number }
export function expectedFromYou(groups: readonly LabApprovalGroup[], runs: readonly InboxRun[]): Expected {
  return { approvals: groups.reduce((n, g) => n + g.approvals.length, 0), stuck: runs.filter((r) => r.bucket === "stuck").length };
}

/** Onay grupları koşu kimliğine bağlıdır: seçili şirketin koşularına ait olanlar (çok şirketli canlı kip). */
export function groupsForRuns(groups: readonly LabApprovalGroup[], runs: readonly InboxRun[]): LabApprovalGroup[] {
  const ids = new Set(runs.map((r) => r.id));
  return groups.filter((g) => ids.has(g.runId));
}

/** Listelenen işlerin maliyet toplamı. NOT: haftalık toplam alanı YOK (§5.3): etiket "listelenen işler" der. */
export function listedCostUsd(runs: readonly InboxRun[]): number {
  return runs.reduce((n, r) => n + (toNumber(r.costUsd) ?? 0), 0);
}

export interface CompanyLine { running: number; approvals: number; stuck: number; done: number; listedCostUsd: number }
export function companyLine(groups: readonly LabApprovalGroup[], runs: readonly InboxRun[]): CompanyLine {
  const m = groupRuns(runs);
  return { running: m.working.length, approvals: groups.reduce((n, g) => n + g.approvals.length, 0), stuck: m.stuck.length, done: m.done.length, listedCostUsd: listedCostUsd(runs) };
}

/* ── Kaputu Aç: `GET /runs/:id` gövdesinin savunmacı okuması (adım + araç çağrısı + maliyet; model/yetki dökümü API ister) ── */
export interface KaputToolCall { id: string; toolName: string; status: string; durationMs: number | null; error: string | null }
export interface KaputStep { id: string; index: number; name: string; agentRole: string | null; status: string; costUsd: number | null; durationMs: number | null; reasoning: string | null; toolCalls: KaputToolCall[]; error?: string | null }
/** `handoffCount` null = okunamadı/yok (uydurulmaz). */
export interface Kaput { steps: KaputStep[]; totalCostUsd: number | null; toolCallCount: number; handoffCount: number | null; runError?: string | null; budgetUsd?: number | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);

export function parseKaput(raw: unknown): Kaput {
  if (!isObj(raw)) return { steps: [], totalCostUsd: null, toolCallCount: 0, handoffCount: null };
  const steps: KaputStep[] = (Array.isArray(raw.steps) ? raw.steps : []).filter(isObj).map((s, i) => ({
    id: str(s.id) ?? `step-${i}`,
    index: toNumber(s.stepIndex) ?? i,
    name: str(s.name) ?? str(s.agentRole) ?? `#${i + 1}`,
    agentRole: str(s.agentRole),
    status: (str(s.status) ?? "unknown").toLowerCase(),
    costUsd: toNumber(s.costUsd),
    durationMs: toNumber(s.durationMs),
    reasoning: str(s.reasoning),
    error: str(s.error),
    toolCalls: (Array.isArray(s.toolCalls) ? s.toolCalls : []).filter(isObj).map((c, j) => ({
      id: str(c.id) ?? `call-${i}-${j}`,
      toolName: str(c.toolName) ?? "?",
      status: (str(c.status) ?? "completed").toLowerCase(),
      durationMs: toNumber(c.durationMs),
      error: str(c.error),
    })),
  }));
  return { steps, totalCostUsd: toNumber(raw.costUsd), toolCallCount: steps.reduce((n, s) => n + s.toolCalls.length, 0), handoffCount: null, runError: str(raw.error), budgetUsd: positive(toNumber(raw.budgetUsd)) };
}
