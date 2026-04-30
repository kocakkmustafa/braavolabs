"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

/**
 * Locale switcher — flips the NEXT_LOCALE cookie and forces a page
 * reload so the server-side getRequestConfig() picks up the new value.
 * Without URL-prefix routing this is the simplest re-render path; the
 * cookie is read on the very next request.
 *
 * If/when we move to URL-prefix routing (app/[locale]/...), swap the
 * cookie write for `router.push(`/${locale}${pathname}`)` and drop the
 * window.location.reload().
 */
const LOCALES = ["en", "tr", "es", "de", "fr", "ar"] as const;

export default function LanguageSwitcher() {
  const current = useLocale();
  const t = useTranslations("language");
  const [isPending, startTransition] = useTransition();

  function setLocale(loc: string) {
    if (loc === current) return;
    // 1 year, root path so every route picks it up.
    document.cookie = `NEXT_LOCALE=${loc}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    startTransition(() => {
      window.location.reload();
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
          outline: "none",
        }}
      >
        {LOCALES.map((loc) => (
          <option key={loc} value={loc} style={{ background: "#0a0d14", color: "#e1e2eb" }}>
            {t(loc)}
          </option>
        ))}
      </select>
    </label>
  );
}
