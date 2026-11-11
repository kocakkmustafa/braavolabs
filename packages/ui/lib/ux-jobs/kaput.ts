/**
 * BRA-UX-05c — "Kaput" (en derin kip) verisi: YALNIZ var olan uçlar (`GET /runs/:id`, `GET /runs/:id/handoffs`).
 * Ayrıştırma `parseKaput` (BRA-UX-04, saf): bilinmeyen alan "bilgi yok" olur, uydurulmaz.
 */
import { api } from "../api";
import { parseKaput, type Kaput } from "../ux-lab/facts";

export async function loadKaput(token: string, runId: string, signal?: AbortSignal): Promise<Kaput> {
  const [run, handoffCount] = await Promise.all([
    api.getRun(token, runId),
    api.listHandoffs(token, runId).then((h: { handoffs?: unknown[] } | null) => (Array.isArray(h?.handoffs) ? h!.handoffs!.length : null)).catch(() => null),
  ]);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  return { ...parseKaput(run), handoffCount };
}
