/**
 * BRA-UX-05h — Modeller ve bağlantılar bayrağı. `/settings/models` yalnız `NEXT_PUBLIC_UX_MODELS=1|true` iken açılır;
 * varsayılan KAPALI ve kapalıyken rota 404 verir (yeni rota: eski sayfa yok, mevcut hiçbir ekran değişmez). Bayrak SUNUCUDA,
 * istek anında okunur (`process.env` nesnesi bütün olarak geçirilir; sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülür).
 */
export const UX_MODELS_ENV = "NEXT_PUBLIC_UX_MODELS";

export function uxModelsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_MODELS_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
