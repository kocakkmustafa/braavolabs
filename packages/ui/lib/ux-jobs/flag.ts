/**
 * BRA-UX-05c — İşler omurgası bayrağı. `/inbox` yalnız `NEXT_PUBLIC_UX_JOBS=1|true` iken yeni İşler ekranını sunar; varsayılan
 * KAPALI ve kapalıyken sayfa `InboxLegacy` (BU BİLETTEN ÖNCEKİ ekran) olarak birebir sunulur. Bayrak SUNUCUDA, istek anında
 * okunur: `process.env` nesnesi bütün olarak geçirilir (sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülür).
 */
export const UX_JOBS_ENV = "NEXT_PUBLIC_UX_JOBS";

export function uxJobsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_JOBS_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
