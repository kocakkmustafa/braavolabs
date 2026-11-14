/**
 * BRA-P1-07b — deterministic synthetic data generator for template pilots.
 *
 * Pure: no Math.random / Date.now / crypto, no I/O. Same (seed, count, kind)
 * always yields byte-identical output. Contains NO personal data: names are
 * "Sahte ..." labels, companies come from a fake-brand list, and nothing
 * resembles an e-mail, phone, national ID, IBAN/card or URL.
 */

export const SYNTHETIC_MAX_COUNT = 1000;

export type SyntheticKind = "task" | "customer" | "mixed";
export type SyntheticStatus = "yeni" | "devam" | "beklemede" | "tamamlandi" | "iptal";

export interface SyntheticRecord {
  id: string;
  kind: "task" | "customer";
  name: string;
  company: string;
  status: SyntheticStatus;
  /** TRY, two decimals, at most 5 integer digits. */
  amount: number;
  /** ISO date (YYYY-MM-DD), derived from a fixed base + seed offset. */
  date: string;
}

export interface GenerateSyntheticDataInput {
  seed: number;
  count: number;
  kind?: SyntheticKind;
}

const FAKE_BRANDS = [
  "Kurgu Atölye", "Mavi Pusula", "Deneme Yapı", "Örnek Lojistik", "Taslak Gıda",
  "Sahte Tekstil", "Maket Yazılım", "Bulut Zanaat", "Yapay Mobilya", "Kum Saati Ltd",
  "Gölge Otomasyon", "Pamuk Dijital", "Test Dokuma", "Hayali Enerji", "Prova Medya",
  "Kâğıt Gemi", "Sentetik Tarım", "Demo Seramik", "Uydurma Danışmanlık", "Sanal Kırtasiye",
] as const;

const TASK_VERBS = [
  "Teklif hazırla", "Sözleşme taslağı gözden geçir", "Stok sayımı yap", "Rapor derle",
  "Toplantı notlarını işle", "Fatura kontrolü", "Sevkiyat planla", "Müşteri geri bildirimini özetle",
] as const;

const STATUSES: readonly SyntheticStatus[] = ["yeni", "devam", "beklemede", "tamamlandi", "iptal"];

const KINDS: readonly SyntheticKind[] = ["task", "customer", "mixed"];

/** Fixed base (2026-01-01 UTC, in ms) — never "now". */
const BASE_DATE_MS = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

/** mulberry32: tiny seeded PRNG, returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function generateSyntheticData(input: GenerateSyntheticDataInput): SyntheticRecord[] {
  const { seed, count, kind = "mixed" } = input;
  if (typeof seed !== "number" || !Number.isInteger(seed)) {
    throw new RangeError("seed must be an integer");
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > SYNTHETIC_MAX_COUNT) {
    throw new RangeError(`count must be an integer between 0 and ${SYNTHETIC_MAX_COUNT}`);
  }
  if (!KINDS.includes(kind)) {
    throw new RangeError("kind must be one of task, customer, mixed");
  }

  const rng = mulberry32(seed);
  const out: SyntheticRecord[] = [];
  for (let i = 1; i <= count; i++) {
    const recKind: "task" | "customer" =
      kind === "mixed" ? (rng() < 0.5 ? "task" : "customer") : kind;
    const company = pick(rng, FAKE_BRANDS);
    const name =
      recKind === "customer"
        ? `Sahte Müşteri ${pad3(i)}`
        : `Sahte Görev ${pad3(i)} - ${pick(rng, TASK_VERBS)}`;
    const status = pick(rng, STATUSES);
    const amount = Math.floor(rng() * 10_000_000) / 100; // < 100000.00
    const date = toIsoDate(BASE_DATE_MS + Math.floor(rng() * 365) * DAY_MS);
    out.push({ id: `syn-${pad3(i)}`, kind: recKind, name, company, status, amount, date });
  }
  return out;
}
