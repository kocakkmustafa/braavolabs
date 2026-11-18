/**
 * BRA-P2-05 — Kaput koşu olay günlüğü: `GET /runs/:id/activity` yanıtının savunmacı ayrıştırması.
 * Bozuk/eksik kalem atlanır; yanıt biçimi tutmuyorsa null (= uç yok/hata → mevcut başlangıç/bitiş zamanına düşülür).
 */
export const ACTIVITY_MAX_LINES = 20;
export const ACTIVITY_SUMMARY_MAX = 160;

export interface KaputActivityItem { id: string; action: string; at: string; actor: "system" | "user" | null; summary: string }
export interface KaputActivity { items: KaputActivityItem[]; hasMore: boolean; truncated: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseActivity(raw: unknown): KaputActivity | null {
  if (!isObj(raw) || !Array.isArray(raw.items)) return null;
  const items: KaputActivityItem[] = [];
  for (const r of raw.items) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.summary !== "string" || typeof r.at !== "string" || Number.isNaN(new Date(r.at).getTime())) continue;
    items.push({
      id: r.id,
      action: typeof r.action === "string" ? r.action : "unknown",
      at: r.at,
      // Kimlik gösterilmez; yalnız sistem/kullanıcı ayrımı.
      actor: r.actor === "system" ? "system" : typeof r.actor === "string" ? "user" : null,
      summary: r.summary,
    });
  }
  return { items, hasMore: typeof raw.nextCursor === "string" && raw.nextCursor.length > 0, truncated: raw.truncated === true };
}
