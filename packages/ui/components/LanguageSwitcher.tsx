"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { locales, localeCookie, normalizeLocale } from "../i18n/locales";

/**
 * Locale switcher — flips the NEXT_LOCALE cookie and forces a page
 * refresh so the server-side getRequestConfig() picks up the new value.
 * Without URL-prefix routing this is the simplest re-render path; the
 * cookie is read on the very next request.
 *
 * If/when we move to URL-prefix routing (app/[locale]/...), swap the
 * cookie write for `router.push(`/${locale}${pathname}`)` and drop the
 * router.refresh().
 */
export default function LanguageSwitcher() {
  const current = normalizeLocale(useLocale()) ?? "en";
  const router = useRouter();
  const t = useTranslations("language");
  const [isPending, startTransition] = useTransition();

  function setLocale(loc: string) {
    const next = normalizeLocale(loc);
    if (!next || next === current) return;
    const cookie = localeCookie(next, window.location.protocol === "https:");
    if (!cookie) return;
    document.cookie = cookie;
    startTransition(() => {
      // RSC refresh preserves the current URL and unrelated client drafts.
      router.refresh();
    });
  }

  return (
    <label
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#859399" }}
      aria-label={t("label")}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">
        language
      </span>
      <select
        aria-label={t("label")}
        value={current}
        onChange={(e) => setLocale(e.target.value)}
        disabled={isPending}
        style={{
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6,
          padding: "4px 8px",
          color: "#bbc9cf",
          fontSize: 12,
          cursor: isPending ? "wait" : "pointer",
          maxWidth: "min(32vw, 10rem)",
        }}
      >
        {locales.map((loc) => (
          <option key={loc} value={loc} style={{ background: "#0a0d14", color: "#e1e2eb" }}>
            {t(loc)}
          </option>
        ))}
      </select>
    </label>
  );
}
