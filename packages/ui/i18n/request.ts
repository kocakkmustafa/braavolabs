import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

/**
 * next-intl runs in "without i18n routing" mode — URLs stay locale-free
 * (no /en/, /tr/, etc.) and the user's preferred language is resolved
 * from a cookie set by the LanguageSwitcher, with browser Accept-Language
 * as the fallback. Adding URL-prefix routing later requires moving the
 * route tree under app/[locale]/ — defer that until SEO need is clear.
 */

export const locales = ["en", "tr", "es", "de", "fr", "ar"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

const COOKIE_KEY = "NEXT_LOCALE";

function pickFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  // Split into ranges, pick first whose primary tag matches a known locale.
  const parts = header.split(",").map((p) => p.split(";")[0].trim().toLowerCase());
  for (const part of parts) {
    const primary = part.split("-")[0];
    if ((locales as readonly string[]).includes(primary)) return primary as Locale;
  }
  return null;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieLocale = cookieStore.get(COOKIE_KEY)?.value;

  let locale: Locale = defaultLocale;
  if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) {
    locale = cookieLocale as Locale;
  } else {
    const accepted = pickFromAcceptLanguage(headerStore.get("accept-language"));
    if (accepted) locale = accepted;
  }

  // Dynamic import keeps the unused locale bundles out of the server
  // payload — only the active locale's JSON gets loaded per request.
  const messages = (await import(`../messages/${locale}.json`)).default;
  return { locale, messages };
});
