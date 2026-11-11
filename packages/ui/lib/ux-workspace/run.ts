/**
 * BRA-UX-05b — `GET /runs/:id` yanıtını iş sayfasının `InboxRun` biçimine indirger. Saf, I/O yok.
 * Kaynak yalnız var olan uç; alan yoksa null/varsayılan olur, uydurulmaz. Detay ucu `bucket` vermez → null
 * (kova yalnız liste ucundadır; bu yüzden bayat kalp atışlı koşu için "yalnız durdur" ayrımı burada yapılamaz, sunucu yine doğrular).
 */
import { JOB_STATES } from "@ai-company-os/core";
import type { InboxRun } from "../inbox";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function toJobRun(raw: unknown): InboxRun | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const status = str(raw.status);
  if (!id || !status) return null;
  const state = (JOB_STATES as readonly string[]).includes(raw.state as string) ? (raw.state as InboxRun["state"]) : null;
  const resultStatus = raw.resultStatus === "VERIFIED" || raw.resultStatus === "UNVERIFIED" ? raw.resultStatus : null;
  const p = isObj(raw.pipeline) ? raw.pipeline : null;
  const c = p && isObj(p.company) ? p.company : null;
  const created = str(raw.createdAt) ?? str(raw.startedAt) ?? "";
  return {
    id, status, state, resultStatus,
    pipelineId: str(raw.pipelineId) ?? str(p?.id) ?? "",
    trigger: str(raw.trigger),
    costUsd: typeof raw.costUsd === "number" || typeof raw.costUsd === "string" ? raw.costUsd : null,
    startedAt: str(raw.startedAt), completedAt: str(raw.completedAt), heartbeatAt: str(raw.heartbeatAt),
    createdAt: created, updatedAt: str(raw.updatedAt) ?? created,
    bucket: null,
    pipeline: p ? { id: str(p.id) ?? "", name: str(p.name) ?? "", company: c && str(c.id) && str(c.name) ? { id: str(c.id)!, name: str(c.name)! } : null } : null,
  };
}
