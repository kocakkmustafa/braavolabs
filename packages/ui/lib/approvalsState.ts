/** BRA-P0-04k — /approvals liste yükleme durumu (saf; jsdom'suz test edilir). */
export type ApprovalsLoad<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T[]; refreshFailed: boolean };

export type ApprovalsView = "loading" | "error" | "empty" | "list";

export const initialApprovalsLoad = <T,>(): ApprovalsLoad<T> => ({ status: "loading" });

/** Yeniden dene: önceden yüklenmiş liste varsa korunur (yükleniyor ekranına dönmez). */
export function startApprovalsLoad<T>(prev: ApprovalsLoad<T>): ApprovalsLoad<T> {
  return prev.status === "ready" ? { ...prev, refreshFailed: false } : { status: "loading" };
}

export function approvalsLoaded<T>(data: T[]): ApprovalsLoad<T> {
  return { status: "ready", data: Array.isArray(data) ? data : [], refreshFailed: false };
}

/** Hata asla boş liste olmaz; önceki liste varsa korunur ve uyarı işaretlenir. */
export function approvalsFailed<T>(prev: ApprovalsLoad<T>): ApprovalsLoad<T> {
  return prev.status === "ready" ? { ...prev, refreshFailed: true } : { status: "error" };
}

export function approvalsRemove<T extends { id: string }>(prev: ApprovalsLoad<T>, id: string): ApprovalsLoad<T> {
  return prev.status === "ready" ? { ...prev, data: prev.data.filter((a) => a.id !== id) } : prev;
}

export function approvalsView<T>(s: ApprovalsLoad<T>): ApprovalsView {
  if (s.status === "loading") return "loading";
  if (s.status === "error") return "error";
  return s.data.length === 0 ? "empty" : "list";
}
