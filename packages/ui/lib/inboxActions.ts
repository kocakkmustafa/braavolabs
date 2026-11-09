/** BRA-P0-04e — onay kararı / makbuz / gönderim sonuçlarının saf sınıflandırması. */
import type { ApprovalDecisionOutcome } from "./approvalDecision";

export type DecisionResult =
  | { kind: "ok" }
  | { kind: "claimFailed" }   // karar KAYDEDİLDİ ama devir alınamadı: koşu FAILED kalabilir
  | { kind: "forbidden" }     // approval:decide yok (403)
  | { kind: "stale" }         // 404/409: başkası karar verdi / değişti → liste yenilenmeli
  | { kind: "error" };

export async function decideResult(send: () => Promise<ApprovalDecisionOutcome>): Promise<DecisionResult> {
  try {
    const r = await send();
    return r.claimFailed === true ? { kind: "claimFailed" } : { kind: "ok" };
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 403) return { kind: "forbidden" };
    if (status === 404 || status === 409) return { kind: "stale" };
    return { kind: "error" };
  }
}

export function decisionMessageKey(k: DecisionResult["kind"]): string | null {
  switch (k) {
    case "forbidden": return "app.inbox.approvalForbidden";
    case "stale": return "app.inbox.approvalConflict";
    case "error": return "app.inbox.approvalFailed";
    default: return null;
  }
}

/** Karar sonrası listeler yenilenmeli mi? (403/genel hatada kart olduğu gibi kalır.) */
export const refreshesLists = (k: DecisionResult["kind"]) => k === "ok" || k === "claimFailed" || k === "stale";

/** Makbuz: yalnız sunucunun `receipt_not_found` 404'ü "makbuz yok"; koşu bulunamadı vb. hata. */
export function receiptFailureKind(err: unknown): "none" | "error" {
  const e = err as { status?: unknown; message?: unknown } | null;
  return e && e.status === 404 && e.message === "receipt_not_found" ? "none" : "error";
}

/** Gönderim: başarıda ok (çağıran metni siler), hatada err (metin korunur). */
export async function trySend(fn: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try { await fn(); return { ok: true }; } catch (err) { return { ok: false, err }; }
}
