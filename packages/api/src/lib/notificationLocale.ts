/** Presentation preference only: never an authorization or tenant input. */
export const NOTIFICATION_LOCALES = ["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export function normalizeNotificationLocale(value: unknown): NotificationLocale | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const candidate = value.trim().replaceAll("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(candidate)) return null;
  let canonical: string;
  try { canonical = Intl.getCanonicalLocales(candidate)[0]; } catch { return null; }
  const exact = NOTIFICATION_LOCALES.find(locale => locale.toLowerCase() === canonical.toLowerCase());
  if (exact) return exact;
  const tag = new Intl.Locale(canonical);
  // A Simplified Chinese catalogue must not claim Traditional Chinese support.
  if (tag.language === "zh") {
    if (tag.script) return tag.script === "Hans" ? "zh-Hans" : null;
    return ["TW", "HK", "MO"].includes(tag.region ?? "") ? null : "zh-Hans";
  }
  const scripts: Record<string, readonly string[]> = {
    tr: ["Latn"], en: ["Latn"], es: ["Latn"], pt: ["Latn"], de: ["Latn"], fr: ["Latn"],
    ja: ["Jpan"], ar: ["Arab"], it: ["Latn"], ko: ["Kore", "Hang"], id: ["Latn"], pl: ["Latn"], hi: ["Deva"],
  };
  if (tag.script && !scripts[tag.language]?.includes(tag.script)) return null;
  if (tag.language === "es") return "es-419";
  if (tag.language === "pt") return "pt-BR";
  return NOTIFICATION_LOCALES.find(locale => locale === tag.language) ?? null;
}

export function resolveNotificationLocale(value: unknown): NotificationLocale {
  return normalizeNotificationLocale(value) ?? "en";
}

/** Bounded quality-weighted HTTP negotiation; explicit app language is one tag. */
export function notificationLocaleFromHeader(value: unknown): NotificationLocale {
  if (typeof value !== "string" || value.length > 8192) return "en";
  const candidates = value.split(",").slice(0, 50).map((part, order) => {
    const [tag, ...options] = part.trim().split(";");
    let quality = 1;
    for (const option of options) {
      const match = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(option.trim());
      if (!match) return { locale: null, quality: 0, order };
      quality = Number(match[1]);
    }
    return { locale: normalizeNotificationLocale(tag), quality, order };
  }).filter(candidate => candidate.locale && candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.order - b.order);
  return candidates[0]?.locale ?? "en";
}
