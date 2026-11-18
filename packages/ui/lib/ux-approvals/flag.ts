/**
 * BRA-UX-05i — Onay ve güvenlik merkezi bayrağı. `/approvals` yalnız `NEXT_PUBLIC_UX_APPROVALS=1|true` iken yeni ekranı sunar;
 * varsayılan KAPALI ve kapalıyken sayfa `ApprovalsLegacy` (BU BİLETTEN ÖNCEKİ ekran) olarak birebir sunulur. Bayrak SUNUCUDA, istek
 * anında okunur (`process.env` nesnesi bütün olarak geçirilir; sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülür).
 * `?view=classic` bayrak açıkken de eski sayfayı verir.
 */
export const UX_APPROVALS_ENV = "NEXT_PUBLIC_UX_APPROVALS";

export function uxApprovalsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_APPROVALS_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Bayrak açık VE `?view=classic` yok → yeni onay merkezi. */
export function showApprovalCenter(enabled: boolean, view: string | string[] | undefined): boolean {
  const v = Array.isArray(view) ? view[0] : view;
  return enabled && v !== "classic";
}
