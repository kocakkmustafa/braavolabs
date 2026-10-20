"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { locales, localeCookie, localeDirection, normalizeLocale, readLocaleCookie } from "../i18n/locales";

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
  const runtimeCopy = useTranslations("runtime");
  const [saveFailed, setSaveFailed] = useState(false);
  const errorId = useId();
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    // Reflect the message provider's accepted locale, not an unconfirmed write.
    document.documentElement.lang = current;
    document.documentElement.dir = localeDirection(current);
  }, [current]);

  function setLocale(loc: string) {
    const next = normalizeLocale(loc);
    if (!next || next === current) return;
    const cookie = localeCookie(next, window.location.protocol === "https:");
    if (!cookie) return;
    try {
      document.cookie = cookie;
      if (readLocaleCookie(document.cookie) !== next) { setSaveFailed(true); return; }
    } catch { setSaveFailed(true); return; }
    setSaveFailed(false);
    startTransition(() => {
      // RSC refresh preserves the current URL and unrelated client drafts.
      router.refresh();
    });
  }

  return (
    <label
      style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6, maxWidth: "100%", fontSize: 12, color: "var(--color-on-surface-variant)" }}
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
        aria-busy={isPending}
        aria-describedby={saveFailed ? errorId : undefined}
        style={{
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6,
          padding: "4px 8px",
          color: "var(--color-on-surface-variant)",
          fontSize: 12,
          cursor: isPending ? "wait" : "pointer",
          maxWidth: "min(100%, 14rem)",
        }}
      >
        {locales.map((loc) => (
          <option key={loc} value={loc} style={{ background: "var(--color-background)", color: "var(--color-on-surface)" }}>
            {t(loc)}
          </option>
        ))}
      </select>
      {saveFailed && <span id={errorId} role="status" style={{ flexBasis: "100%", color: "var(--color-error)" }}>{runtimeCopy("localeSaveFailed")}</span>}
    </label>
  );
}
