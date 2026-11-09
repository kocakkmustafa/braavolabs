/** BRA-P0-04k — /approvals liste yükleme durumu (saf; jsdom'suz test edilir). */
export type ApprovalsLoad<T> =
  | { status: "loading" }
  | { status: "error"; retrying: boolean }
  | { status: "ready"; data: T[]; refreshFailed: boolean; retrying: boolean };

export type ApprovalsView = "loading" | "error" | "empty" | "list";

export const initialApprovalsLoad = <T,>(): ApprovalsLoad<T> => ({ status: "loading" });

/** Yeniden dene: uyarı/hata bölgesi yerinde kalır (odak kaybolmaz), yalnız `retrying` işaretlenir. */
export function startApprovalsLoad<T>(prev: ApprovalsLoad<T>): ApprovalsLoad<T> {
  if (prev.status === "ready") return { ...prev, retrying: true };
  if (prev.status === "error") return { status: "error", retrying: true };
  return prev;
}

/** Dizi olmayan başarılı gövde (null, {}, 204) boş liste DEĞİL, hatadır. */
export function approvalsLoaded<T>(data: unknown, prev: ApprovalsLoad<T> = initialApprovalsLoad<T>()): ApprovalsLoad<T> {
  if (!Array.isArray(data)) return approvalsFailed(prev);
  return { status: "ready", data: data as T[], refreshFailed: false, retrying: false };
}

/** Hata asla boş liste olmaz; önceki liste varsa korunur ve uyarı işaretlenir. */
export function approvalsFailed<T>(prev: ApprovalsLoad<T>): ApprovalsLoad<T> {
  return prev.status === "ready" ? { ...prev, refreshFailed: true, retrying: false } : { status: "error", retrying: false };
}

export function approvalsRemove<T extends { id: string }>(prev: ApprovalsLoad<T>, id: string): ApprovalsLoad<T> {
  return prev.status === "ready" ? { ...prev, data: prev.data.filter((a) => a.id !== id) } : prev;
}

/** Boş liste + yenileme hatası "Her şey temiz" DEĞİL, hata görünümüdür. */
export function approvalsView<T>(s: ApprovalsLoad<T>): ApprovalsView {
  if (s.status === "loading") return "loading";
  if (s.status === "error") return "error";
  if (s.data.length === 0) return s.refreshFailed ? "error" : "empty";
  return "list";
}

/** Hata/uyarı bölgesi bilgisi: tam hata mı, liste üstünde uyarı mı, meşgul mü. */
export function approvalsAlert<T>(s: ApprovalsLoad<T>): { show: boolean; inline: boolean; busy: boolean } {
  const v = approvalsView(s);
  if (v === "error") return { show: true, inline: false, busy: s.status !== "loading" && s.retrying };
  if (s.status === "ready" && s.refreshFailed) return { show: true, inline: true, busy: s.retrying };
  return { show: false, inline: false, busy: false };
}
