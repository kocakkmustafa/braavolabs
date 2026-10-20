/** Shared client/server locale contract. URLs remain locale-free. */
export const locales = ["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Legacy `es` preferences resolve to the supported Latin American catalogue.
 * Regional browser preferences use the sole supported variant of that language;
 * this does not claim translations for es-ES or pt-PT are separately supported.
 */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const candidate = value.trim().replaceAll("_", "-");
  if (!candidate || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(candidate)) return null;
  let canonical: string;
  try { canonical = Intl.getCanonicalLocales(candidate)[0]; } catch { return null; }
  const exact = locales.find(locale => locale.toLowerCase() === canonical.toLowerCase());
  if (exact) return exact;
  const tag = new Intl.Locale(canonical);
  // A Simplified Chinese catalogue does not provide a Traditional Chinese
  // translation. An explicit script wins over a region hint.
  if (tag.language === "zh") {
    if (tag.script) return tag.script === "Hans" ? "zh-Hans" : null;
    return ["TW", "HK", "MO"].includes(tag.region ?? "") ? null : "zh-Hans";
  }
  const scripts: Record<string, readonly string[]> = {
    tr: ["Latn"], en: ["Latn"], es: ["Latn"], pt: ["Latn"], de: ["Latn"], fr: ["Latn"],
    ja: ["Jpan"], ar: ["Arab"], it: ["Latn"], ko: ["Kore", "Hang"], id: ["Latn"], pl: ["Latn"], hi: ["Deva"],
  };
  if (tag.script && !scripts[tag.language]?.includes(tag.script)) return null;
  switch (tag.language) {
    case "es": return "es-419";
    case "pt": return "pt-BR";
    case "tr": return "tr";
    case "en": return "en";
    case "de": return "de";
    case "fr": return "fr";
    case "ja": return "ja";
    case "ar": return "ar";
    case "it": return "it";
    case "ko": return "ko";
    case "id": return "id";
    case "pl": return "pl";
    case "hi": return "hi";
    default: return null;
  }
}

export function pickFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header || header.length > 8192) return null;
  const candidates = header.split(",").map((range, index) => {
    const [tag, ...parameters] = range.trim().split(";");
    const quality = parameters.find(parameter => /^\s*q\s*=/i.test(parameter));
    let weight = 1;
    if (quality !== undefined) {
      const match = quality.match(/^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i);
      weight = match ? Number(match[1]) : 0;
    }
    return { locale: normalizeLocale(tag), weight, index };
  }).filter(candidate => candidate.locale !== null && candidate.weight > 0);
  candidates.sort((a, b) => b.weight - a.weight || a.index - b.index);
  return candidates[0]?.locale ?? null;
}

export function resolveLocale(cookie: unknown, acceptLanguage?: string | null): Locale {
  return normalizeLocale(cookie) ?? pickFromAcceptLanguage(acceptLanguage) ?? defaultLocale;
}

export function localeDirection(locale: unknown): "rtl" | "ltr" {
  return normalizeLocale(locale) === "ar" ? "rtl" : "ltr";
}

export function localeCookie(value: unknown, secure = false): string | null {
  const locale = normalizeLocale(value);
  if (!locale) return null;
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Browser requests use the saved app choice, never an OS-language override. */
export function readLocaleCookie(value: unknown): Locale | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0 || part.slice(0, equals).trim() !== LOCALE_COOKIE) continue;
    try { return normalizeLocale(decodeURIComponent(part.slice(equals + 1).trim())); }
    catch { return null; }
  }
  return null;
}

export function localeFromCookieHeader(value: unknown): Locale {
  return readLocaleCookie(value) ?? defaultLocale;
}

function finiteValue(value: unknown): number | null {
  // Unknown/empty values are not represented as zero spending or zero usage.
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function formatNumber(value: unknown, locale: unknown, options?: Intl.NumberFormatOptions): string {
  const number = finiteValue(value);
  if (number === null) return "—";
  try { return new Intl.NumberFormat(normalizeLocale(locale) ?? defaultLocale, options).format(number); }
  catch { return "—"; }
}

/** Currency is supplied by the underlying record; formatting never converts it. */
export function formatCurrency(value: unknown, currency: string, locale: unknown, options?: Intl.NumberFormatOptions): string {
  if (!/^[a-z]{3}$/i.test(currency)) return "—";
  return formatNumber(value, locale, { ...options, style: "currency", currency: currency.toUpperCase() });
}

/** A caller must choose its time zone explicitly instead of silently changing
 * a run's instant when the language is changed. */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  locale: unknown,
  options: Intl.DateTimeFormatOptions & { timeZone: string },
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try { return new Intl.DateTimeFormat(normalizeLocale(locale) ?? defaultLocale, options).format(date); }
  catch { return "—"; }
}

/** Keep the viewer's time zone independent of the selected display language. */
export function currentTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

export function formatDurationMs(value: unknown, locale: unknown): string {
  const milliseconds = finiteValue(value);
  if (milliseconds === null || milliseconds < 0) return "—";
  if (milliseconds < 1000) return formatNumber(milliseconds, locale, { style: "unit", unit: "millisecond", maximumFractionDigits: 0 });
  const seconds = milliseconds / 1000;
  return formatNumber(seconds < 60 ? seconds : seconds / 60, locale, {
    style: "unit", unit: seconds < 60 ? "second" : "minute", maximumFractionDigits: 2,
  });
}
