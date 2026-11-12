/** BRA-UX-05i — onay merkezi saf yardımcıları (jsdom'suz test edilir). Kaynak yoksa (null) "Bilgi yok"; ASLA uydurulmaz. */

export type ApprovalRisk = "low" | "medium" | "high";

export interface CenterDetails {
  risk: ApprovalRisk | null;
  permissions: string[] | null;
  dataTransfer: string[] | null;
  reversible: boolean | null;
}

export interface CenterApproval {
  id: string;
  runId?: string;
  type?: string | null;
  description: string;
  /** Prisma Decimal(10,2) JSON'da METİN ("12.50") gelebilir; her kullanım `parseAmount` ile okunur. */
  amountUsd?: number | string | null;
  createdAt?: string;
  metadata?: { toolName?: unknown } | null;
  details?: Partial<CenterDetails> | null;
  artifact?: { kind: "email" | "social_post" | "message" | "content"; title?: string; body: string; source: "draft" | "action" } | null;
  run?: { pipeline?: { name?: string | null; company?: { name?: string | null } | null } | null } | null;
}

const RISKS: readonly string[] = ["low", "medium", "high"];

/** API `details`'ı (eski onayda yok/null) kapalı şemaya indirir; beklenmeyen şekil null olur. */
export function readDetails(a: Pick<CenterApproval, "details">): CenterDetails {
  const d = a.details && typeof a.details === "object" ? a.details : {};
  const list = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return out.length ? out : null;
  };
  return {
    risk: typeof d.risk === "string" && RISKS.includes(d.risk) ? (d.risk as ApprovalRisk) : null,
    permissions: list(d.permissions),
    dataTransfer: list(d.dataTransfer),
    reversible: typeof d.reversible === "boolean" ? d.reversible : null,
  };
}

export function toolName(a: Pick<CenterApproval, "metadata">): string | null {
  const n = a.metadata?.toolName;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/** Tutar: sonlu ≥0 sayı ya da sonlu sayıya çevrilebilen boş olmayan metin ("12.50"); diğer her şey null (uydurma yok). */
export function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Tehlikeli = para (`amountUsd > 0`) VEYA yüksek risk VEYA geri alınamaz (`reversible === false`). null "tehlikesiz" demek DEĞİL ama uydurma da yok. */
export function isDangerous(a: Pick<CenterApproval, "amountUsd" | "details">): boolean {
  const d = readDetails(a);
  return ((parseAmount(a.amountUsd) ?? 0) > 0) || d.risk === "high" || d.reversible === false;
}

/** Onay cümlesi eşleşmesi: büyük/küçük harf ve baştaki/sondaki boşluk duyarsız (iç boşluklar tek boşluğa indirilir). */
export function phraseMatches(input: string, phrase: string, locale?: string): boolean {
  const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase(locale).normalize("NFC");
  const want = norm(phrase);
  return want !== "" && norm(input) === want;
}

/** "Onayla" açık mı: tehlikesizde her zaman; tehlikelide cümle eşleşince. */
export function canApprove(dangerous: boolean, typed: string, phrase: string, locale?: string): boolean {
  return !dangerous || phraseMatches(typed, phrase, locale);
}

/** Geri alma etiketi için i18n anahtarı (`app.approvalCenter.*` altı). */
export function reversibleKey(reversible: boolean | null): "reversibleYes" | "reversibleNo" | "unknown" {
  return reversible === true ? "reversibleYes" : reversible === false ? "reversibleNo" : "unknown";
}

/** Boş/yok değer "Bilgi yok" anahtarına düşer; dolu metin aynen döner. */
export function textOrUnknown(value: string | string[] | null | undefined): { text: string } | { unknown: true } {
  const v = Array.isArray(value) ? value.join(", ") : value;
  return typeof v === "string" && v.trim() ? { text: v.trim() } : { unknown: true };
}

/** `decide` notu: boşsa hiç gönderilmez (mevcut `note` alanı; uydurma alan yok). */
export function decisionNote(reason: string): string | undefined {
  const r = reason.trim();
  return r ? r : undefined;
}
