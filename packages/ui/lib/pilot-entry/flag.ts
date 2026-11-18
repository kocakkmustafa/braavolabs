/**
 * BRA-P1-07-N3 — Pilot giriş kartı bayrağı. Kart yalnız `NEXT_PUBLIC_UX_PILOT=1|true` iken görünür; varsayılan KAPALI.
 * `process.env` nesnesi bütün olarak geçirilebilir (test); istemcide çağıran sabit `process.env.NEXT_PUBLIC_UX_PILOT` verir.
 */
export const UX_PILOT_ENV = "NEXT_PUBLIC_UX_PILOT";

export function uxPilotEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[UX_PILOT_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}
