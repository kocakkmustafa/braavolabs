/**
 * BRA-UX-05f — Şirket durumu bayrağı. `/companies/[id]/status` yalnız `NEXT_PUBLIC_UX_COMPANY=1|true` iken açılır; varsayılan KAPALI ve
 * kapalıyken rota 404 verir (yeni rota: mevcut `/companies` ve `/companies/[id]` sayfalarına dokunulmaz). Bayrak SUNUCUDA, istek anında okunur
 * (`process.env` nesnesi bütün olarak geçirilir; sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülür).
 */
export const UX_COMPANY_ENV = "NEXT_PUBLIC_UX_COMPANY";

export function uxCompanyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_COMPANY_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
