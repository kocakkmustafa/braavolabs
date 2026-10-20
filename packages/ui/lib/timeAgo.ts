import { defaultLocale, normalizeLocale } from "../i18n/locales";

/** Selected application language; invalid timestamps remain unknown. */
export function timeAgo(dateStr: string | undefined, locale: unknown = defaultLocale, now = Date.now()): string {
  if (!dateStr) return "—";
  const instant = new Date(dateStr).getTime();
  if (!Number.isFinite(instant) || !Number.isFinite(now)) return "—";
  const seconds = (instant - now) / 1000;
  const magnitude = Math.abs(seconds);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] = magnitude < 60 ? [1, "second"] : magnitude < 3600 ? [60, "minute"] : magnitude < 86400 ? [3600, "hour"] : [86400, "day"];
  return new Intl.RelativeTimeFormat(normalizeLocale(locale) ?? defaultLocale, { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}
