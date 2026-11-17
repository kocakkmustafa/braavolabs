/**
 * BRA-UX-05g — Ajanlar ekranı bayrağı. `/agents` yalnız `NEXT_PUBLIC_UX_AGENTS=1|true` iken açılır; varsayılan KAPALI ve
 * kapalıyken rota yok sayılır (404: bu bilet öncesinde de `/agents` rotası yoktu). Bayrak SUNUCUDA, istek anında okunur:
 * `process.env` nesnesi bütün olarak geçirilir (sabit `process.env.NEXT_PUBLIC_…` erişimi derleme anında gömülür).
 */
export const UX_AGENTS_ENV = "NEXT_PUBLIC_UX_AGENTS";

export function uxAgentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_AGENTS_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
