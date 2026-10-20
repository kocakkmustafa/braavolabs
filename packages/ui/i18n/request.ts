import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveLocale } from "./locales";
export { locales, defaultLocale, type Locale } from "./locales";

/**
 * next-intl runs in "without i18n routing" mode — URLs stay locale-free
 * (no /en/, /tr/, etc.) and the user's preferred language is resolved
 * from a cookie set by the LanguageSwitcher, with browser Accept-Language
 * as the fallback. Adding URL-prefix routing later requires moving the
 * route tree under app/[locale]/ — defer that until SEO need is clear.
 */

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language"));

  // Dynamic import keeps the unused locale bundles out of the server
  // payload — only the active locale's JSON gets loaded per request.
  const messages = (await import(`../messages/${locale}.json`)).default;
  return { locale, messages };
});
