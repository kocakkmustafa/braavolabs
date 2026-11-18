/**
 * BRA-UX-05e — kod özeti ne zaman (yeniden) çekilir. Çıktı sekmesi açıkken iş durumu/`updatedAt` değişirse (iş sayfası yoklaması, İşler listesi
 * tazelemesi) özet SESSİZCE yenilenir: önceki veri yerinde kalır (yükleniyor göstergesi/titreme yok), hata olursa eski veri korunur.
 * Gecikmiş yanıtı `seq` eler (JobModes). Karar saf fonksiyondur ki birim testle doğrulansın.
 */
import { effectiveState, type InboxRun } from "../inbox";

/** [iş kimliği, updatedAt, etkin durum] — bunlardan biri değişince özet bayatlamış sayılır. */
export type CodeSig = [string, string, string];
export const codeSig = (run: Pick<InboxRun, "id" | "updatedAt" | "state" | "status">): CodeSig => [run.id, run.updatedAt ?? "", effectiveState(run) ?? ""];

export type CodePlan = "fetch" | "silent" | "none";
export function planCodeFetch(prev: CodeSig | null, next: CodeSig, current: "none" | "loading" | "ready" | "error"): CodePlan {
  if (current === "none") return "fetch";
  if (prev === null || prev[0] !== next[0]) return "fetch";
  if (prev[1] === next[1] && prev[2] === next[2]) return "none";
  return current === "ready" ? "silent" : "fetch";
}

/** Onay bağlantısı: kovaya DEĞİL etkin duruma bakar (iş sayfası detay ucu `bucket` vermez; `state:null,status:"WAITING_APPROVAL"` da sayılır). */
export const isAwaitingApproval = (run: Pick<InboxRun, "state" | "status">): boolean => effectiveState(run) === "NEEDS_APPROVAL";
