/**
 * BRA-UX-05c — İşler satırı/çekmecesi saf yardımcıları. I/O yok; metin anahtarı döndürür, çeviri bileşende.
 * Kaynak: yalnız var olan uçların alanları (`/runs?bucket=`, `/approvals?groupBy=run`, `/runs/:id`, `/runs/:id/handoffs`).
 */
import { effectiveState, type InboxRun } from "../inbox";

const KNOWN_STATES = ["DRAFT", "PLANNED", "READY", "RUNNING", "NEEDS_APPROVAL", "RESUMING", "PAUSED", "FAILED", "CANCELLED", "COMPLETED"] as const;

/** Durum etiketi anahtarı (`app.jobs.state.*`); bilinmeyen ya da yok → `unknown` (uydurma etiket yok). */
export function stateKey(run: InboxRun): string {
  const s = effectiveState(run);
  return `app.jobs.state.${s && (KNOWN_STATES as readonly string[]).includes(s) ? s : "unknown"}`;
}

/** Onay riski anahtarı; alan yoksa/bilinmiyorsa null (satırda risk gösterilmez, "düşük" varsayılmaz). */
export function riskKey(risk: unknown): "low" | "medium" | "high" | null {
  return risk === "low" || risk === "medium" || risk === "high" ? risk : null;
}

/** Onay satırının riski (`details.risk`, PR #133 liste ucu); eski API'de `details` yoktur. */
export function approvalRisk(a: { details?: { risk?: unknown } | null }): "low" | "medium" | "high" | null {
  return riskKey(a.details?.risk);
}

/** Sonuç doğrulama etiketi anahtarı (`receipt`/`resultStatus`); alan yoksa "doğrulama bilgisi yok". */
export function verificationKey(run: Pick<InboxRun, "resultStatus">): "verified" | "unverified" | "noVerification" {
  return run.resultStatus === "VERIFIED" ? "verified" : run.resultStatus === "UNVERIFIED" ? "unverified" : "noVerification";
}
