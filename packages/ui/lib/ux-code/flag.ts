/**
 * BRA-UX-05e — Kod değişikliği kartı bayrağı. Çıktı sekmesindeki "Kod değişikliğini incele" kartı yalnız `NEXT_PUBLIC_UX_CODE=1|true` iken
 * görünür ve `/runs/:id/code-summary` yalnız o zaman istenir; varsayılan KAPALI ve kapalıyken ekran/istekler hiç değişmez. Bayrak SUNUCUDA,
 * istek anında okunur (`process.env` nesnesi bütün olarak geçirilir; sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülür).
 * Sunucu sarmalayıcılar (`/runs/[id]`, `/inbox`) okuyup `codeChange` boolean'ı olarak istemci bileşenlerine iletir.
 */
export const UX_CODE_ENV = "NEXT_PUBLIC_UX_CODE";

export function uxCodeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_CODE_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
