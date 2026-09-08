"use client";

import { useEffect, useState } from "react";

/**
 * Minimal KVKK/GDPR cookie consent banner.
 *
 * Decision is persisted in localStorage and never re-prompts on the same
 * device. Accepted choice surfaces as a `cookie_consent` key with one of
 * the values defined below — analytics integrations downstream can read
 * this to gate their loaders.
 *
 * Locale-aware: shows Turkish copy when the visitor's browser locale starts
 * with "tr" OR Cloudflare's CF-IPCountry cookie reports TR; otherwise
 * English (matching the page's <html lang="en">). The banner element gets
 * a matching `lang` attribute so screen readers pronounce it correctly.
 * Earlier the banner was always Turkish on a lang="en" page — a real
 * WCAG 3.1.2 (Language of Parts) failure plus cognitive-load tax for
 * non-Turkish visitors.
 *
 * No dependency — react-cookie-consent only adds 30 lines on top of this.
 */
type Consent = "accepted" | "essential-only";
type Locale = "en" | "tr";
const STORAGE_KEY = "cookie_consent";

export function getCookieConsent(): Consent | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "accepted" || v === "essential-only" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Clear the stored consent and re-trigger the banner. Required for KVKK
 * Article 11 / GDPR Article 7(3): withdrawal must be as easy as giving
 * consent. Callers (footer link, /cookies page button, settings panel)
 * should reload the page afterwards or rely on the storage event the
 * banner re-mount listens for.
 */
export function clearCookieConsent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    // Synthesize a storage event so other tabs / mounted banners see the
    // change without a full reload. localStorage doesn't emit a "storage"
    // event in the same tab, hence the manual dispatch.
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  } catch {
    /* private mode / disabled storage — caller should fall back to reload */
  }
}

function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
  // 1) Cloudflare geo cookie wins — covers Turkish visitors with English
  // browsers (common: tech-fluent founders running EN UI but in Türkiye).
  try {
    const cookies = document.cookie.split(";").map((c) => c.trim());
    const cf = cookies.find(
      (c) => c.toLowerCase().startsWith("cf_country=") || c.toLowerCase().startsWith("cf-ipcountry="),
    );
    if (cf && cf.toUpperCase().includes("=TR")) return "tr";
  } catch {
    /* ignore */
  }
  // 2) navigator.language fallback
  try {
    const lang = (navigator.language || (navigator as any).userLanguage || "en").toLowerCase();
    return lang.startsWith("tr") ? "tr" : "en";
  } catch {
    return "en";
  }
}

const COPY: Record<Locale, {
  title: string;
  body: (privacyLabel: string) => React.ReactNode;
  privacyLabel: string;
  acceptAll: string;
  essentialOnly: string;
  ariaLabel: string;
}> = {
  en: {
    title: "Cookies & privacy",
    body: (privacyLabel) => (
      <>
        Braavolabs uses essential cookies for session and security. Optional
        anonymous analytics help us improve the product — no personal data is
        collected, IP addresses are redacted.{" "}
        <a href="/privacy" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
          {privacyLabel}
        </a>
        {" · "}
        <a href="/cookies" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
          Cookie Policy
        </a>
        .
      </>
    ),
    privacyLabel: "Privacy Policy",
    acceptAll: "Accept all",
    essentialOnly: "Essential only",
    ariaLabel: "Cookie consent",
  },
  tr: {
    title: "Çerezler hakkında",
    body: (privacyLabel) => (
      <>
        Braavolabs, oturum yönetimi ve servis güvenliği için zorunlu çerezler
        kullanır. İstersen anonim kullanım analitiğine de izin verebilirsin —
        kişisel veri toplamayız, IP'ler bile redact'lenir.{" "}
        <a href="/privacy" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
          {privacyLabel}
        </a>
        {" · "}
        <a href="/cookies" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
          Çerez Politikası
        </a>
        {" · "}
        <a href="/kvkk" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
          KVKK
        </a>
        .
      </>
    ),
    privacyLabel: "Gizlilik Politikası",
    acceptAll: "Hepsini kabul et",
    essentialOnly: "Sadece zorunlu olanlar",
    ariaLabel: "Çerez tercihleri",
  },
};

export default function CookieConsent() {
  // null = not decided yet → show banner; string = decided → hide.
  const [consent, setConsent] = useState<Consent | null | "loading">("loading");
  const [locale, setLocale] = useState<Locale>("en");

  useEffect(() => {
    setConsent(getCookieConsent());
    setLocale(detectLocale());
    // Re-evaluate when clearCookieConsent() dispatches the synthetic
    // storage event — lets the "Cookie Settings" link re-show the banner
    // without a full page reload.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === STORAGE_KEY) {
        setConsent(getCookieConsent());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // SSR + first hydrate → render nothing to avoid layout flash. Real
  // banner only appears once we've checked localStorage on the client.
  if (consent === "loading" || consent !== null) return null;

  function decide(choice: Consent) {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* private mode / disabled storage — banner just won't persist */
    }
    setConsent(choice);
  }

  const copy = COPY[locale];

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-consent-title"
      aria-live="polite"
      lang={locale}
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        right: 16,
        maxWidth: 720,
        margin: "0 auto",
        zIndex: 9999,
        background: "rgba(15, 19, 26, 0.96)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 16,
        padding: "16px 20px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        color: "#bbc9cf",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <p
            id="cookie-consent-title"
            style={{ margin: 0, color: "#e1e2eb", fontWeight: 600, marginBottom: 4 }}
          >
            {copy.title}
          </p>
          <p style={{ margin: 0 }}>{copy.body(copy.privacyLabel)}</p>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={() => decide("essential-only")}
            aria-label={copy.essentialOnly}
            style={{
              padding: "10px 16px",
              minHeight: 44,
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "#bbc9cf",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {copy.essentialOnly}
          </button>
          <button
            type="button"
            onClick={() => decide("accepted")}
            aria-label={copy.acceptAll}
            style={{
              padding: "10px 16px",
              minHeight: 44,
              borderRadius: 10,
              border: "none",
              background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
              color: "white",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {copy.acceptAll}
          </button>
        </div>
      </div>
    </div>
  );
}
