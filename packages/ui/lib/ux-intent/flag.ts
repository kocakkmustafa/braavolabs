/**
 * BRA-UX-05a — Niyet Çubuğu bayrağı. `/start` yalnız `NEXT_PUBLIC_UX_INTENT=1|true` iken yeni ekranı sunar;
 * varsayılan KAPALI: eski ekran, değişmeden. Bayrak SUNUCUDA, istek anında okunur (`process.env` nesnesi bütün olarak
 * geçirilir; sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında satır içine gömülürdü). Geri alma = bayrağı kapat.
 */
export const UX_INTENT_ENV = "NEXT_PUBLIC_UX_INTENT";

export function uxIntentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_INTENT_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
