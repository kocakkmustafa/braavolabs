/**
 * BRA-UX-04 — prototip bayrağı. `/lab/ux` yalnız `NEXT_PUBLIC_UX_LAB=1|true` iken açılır; varsayılan KAPALI
 * (04-design.md §12.1). Bayrak SUNUCUDA, istek anında okunur: `process.env` nesnesi bütün olarak geçirilir
 * (`process.env.NEXT_PUBLIC_UX_LAB` sabit erişimi derleme anında satır içine gömülür; burada istenen bu değil).
 * Mevcut ekranlar bu bayrağa bakmaz: kapalıyken hiçbiri değişmez.
 */
export const UX_LAB_ENV = "NEXT_PUBLIC_UX_LAB";

export function uxLabEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_LAB_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
