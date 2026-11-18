/** BRA-P0-04e — sayfa durum makinesinin saf parçaları (jsdom'suz test edilebilsin diye sayfadan ayrıldı). */
import type { InboxApprovalGroup } from "./inbox";

export type Load<D> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: D; cursor: string | null; more: boolean; moreError: boolean };

/** cursor = "daha fazla"; silent = eylem sonrası yenileme (listeyi, odağı ve sayfalamayı korur). */
export function startLoad<D>(prev: Load<D>, cursor: string | null, silent: boolean): Load<D> {
  if (cursor) return prev.status === "ready" ? { ...prev, more: true, moreError: false } : prev;
  if (silent && prev.status === "ready") return prev;
  return { status: "loading" };
}

export function finishLoad<D>(
  prev: Load<D>, cursor: string | null, silent: boolean, incoming: D, nextCursor: string | null,
  appendPage: (old: D, inc: D) => D, refreshFirst: (old: D, inc: D) => D, loadedMoreThanFirst: (old: D, inc: D) => boolean,
): Load<D> {
  if (cursor && prev.status === "ready") return { status: "ready", data: appendPage(prev.data, incoming), cursor: nextCursor, more: false, moreError: false };
  if (silent && prev.status === "ready") {
    const keep = loadedMoreThanFirst(prev.data, incoming);
    return { status: "ready", data: refreshFirst(prev.data, incoming), cursor: keep ? prev.cursor : nextCursor, more: false, moreError: false };
  }
  return { status: "ready", data: incoming, cursor: nextCursor, more: false, moreError: false };
}

/** Hata: "daha fazla" ve sessiz yenileme listeyi KORUR; ilk yükleme hatası hata durumudur (asla boş değil). */
export function failLoad<D>(prev: Load<D>, cursor: string | null, silent: boolean): Load<D> {
  if (prev.status === "ready" && cursor) return { ...prev, more: false, moreError: true };
  if (prev.status === "ready" && silent) return { ...prev, more: false };
  return { status: "error" };
}

/** Sessiz yenileme: ilk sayfa taze, sonraki sayfalardaki (yüklü) satırlar korunur; eylem yapılan satır düşer. */
export function refreshRunsFirstPage<T extends { id: string }>(old: T[], incoming: T[], dropId?: string): T[] {
  const fresh = new Set(incoming.map((x) => x.id));
  return [...incoming, ...old.filter((x) => !fresh.has(x.id) && x.id !== dropId)];
}

export function refreshGroupsFirstPage(old: InboxApprovalGroup[], incoming: InboxApprovalGroup[], droppedApprovalId?: string): InboxApprovalGroup[] {
  const freshIds = new Set(incoming.flatMap((g) => g.approvals.map((a) => a.id)));
  const rest = old
    .map((g) => ({ ...g, approvals: g.approvals.filter((a) => !freshIds.has(a.id) && a.id !== droppedApprovalId) }))
    .filter((g) => g.approvals.length > 0);
  const merged = incoming.map((g) => ({ ...g, approvals: g.approvals.slice() }));
  const byRun = new Map(merged.map((g) => [g.runId, g]));
  for (const g of rest) {
    const cur = byRun.get(g.runId);
    if (cur) cur.approvals.push(...g.approvals);
    else { merged.push(g); byRun.set(g.runId, g); }
  }
  return merged;
}

/** Satır başına eşzamanlı kilit (çift tıklama / iki farklı satır karışmaz). */
export function createRowLock() {
  const held = new Set<string>();
  return {
    acquire(id: string): boolean { if (held.has(id)) return false; held.add(id); return true; },
    release(id: string): void { held.delete(id); },
    has: (id: string) => held.has(id),
    snapshot: () => new Set(held),
  };
}
