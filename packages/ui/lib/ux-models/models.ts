/**
 * BRA-UX-05h — `GET /companies/:id/models` (BRA-UX-API-02) yanıtının GÖRÜNÜM katmanı. Saf fonksiyonlar: kaynak veri olmayan her alan
 * `null` gelir ve arayüzde "Bilinmiyor" olarak okunur; bu katman hiçbir değer UYDURMAZ, tahmin etmez, varsayılan koymaz.
 */
import type { ModelOverviewItem, ModelsOverview } from "@ai-company-os/core";

export type SourceKey = "byok" | "local" | "platform" | "unknown";
export type ScopeKey = "company" | "workspace" | "agent" | "unknown";
export type ModeKey = "read" | "read_write" | "unknown";

export interface ModelRow {
  id: string;
  provider: string | null;
  displayName: string | null;
  source: SourceKey;
  scope: ScopeKey;
  mode: ModeKey;
  /** Ondalık METİN geçerliyse sayı; null/bozuk → null ("Bilinmiyor"). Float'a yalnız GÖSTERİM için çevrilir. */
  cost: number | null;
  runCount: number | null;
}

export interface OverviewView {
  /** true/false/null: null → "Bilinmiyor" (API bugün hep null döner). */
  autoSelection: boolean | null;
  rows: ModelRow[];
  generatedAt: string | null;
  costFrom: string | null;
}

const COST_RE = /^\d+(\.\d+)?$/;

/** Yalnız `rakam[.rakam]` metni kabul (Decimal METİN); negatif, üstel, virgül, boş, sayı-dışı → null. Sayı tipi de kabul edilir (güvenli sonlu ≥0). */
export function parseCostUsd(v: unknown): number | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (!COST_RE.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  return null;
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function toModelRow(m: ModelOverviewItem): ModelRow {
  const access = (m?.access ?? {}) as Partial<ModelOverviewItem["access"]>;
  return {
    id: String(m?.id ?? ""),
    provider: str(m?.provider),
    displayName: str(m?.displayName),
    source: pick(m?.source, ["byok", "local", "platform"] as const) ?? "unknown",
    scope: pick(access.scope, ["company", "workspace", "agent"] as const) ?? "unknown",
    mode: pick(access.mode, ["read", "read_write"] as const) ?? "unknown",
    cost: parseCostUsd(m?.costThisMonthUsd),
    runCount: count(m?.runCountThisMonth),
  };
}

/** Bozuk/eksik yanıt çökertmez: modeller dizi değilse boş liste. Bilinmeyen kaynak/yetki/maliyet "unknown"/null kalır. */
export function toOverviewView(o: ModelsOverview | null | undefined): OverviewView {
  const rows = Array.isArray(o?.models) ? o!.models.filter((m) => m && typeof m.id === "string" && m.id !== "").map(toModelRow) : [];
  const enabled = o?.autoSelection?.enabled;
  return {
    autoSelection: typeof enabled === "boolean" ? enabled : null,
    rows,
    generatedAt: str(o?.generatedAt),
    costFrom: str(o?.costWindow?.from),
  };
}

/** `useDisplayFormats().usd` en çok 4 ondalık gösterir: 0'dan büyük ama bu hassasiyetin altındaki maliyet "$0.00" görünüp sıfırdan ayırt edilemez olmasın. */
export const COST_DISPLAY_FLOOR = 0.0001;
export function isBelowCostPrecision(cost: number): boolean {
  return cost > 0 && cost < COST_DISPLAY_FLOOR;
}
