"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { getCookieConsent, setCookieConsent, subscribeCookieConsent, type CookieConsent as Consent } from "../lib/cookie-consent";

// Preserve the existing caller API while sharing one consent state.
export { clearCookieConsent, getCookieConsent } from "../lib/cookie-consent";

export default function CookieConsent() {
  const locale = useLocale();
  const t = useTranslations("static.cookieConsent");
  const [consent, setConsent] = useState<Consent | null | "loading">("loading");
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    const update = () => setConsent(getCookieConsent());
    const unsubscribe = subscribeCookieConsent(update);
    update();
    return unsubscribe;
  }, []);

  if (consent === "loading" || consent !== null) return null;

  function decide(choice: Consent) {
    setSaveFailed(!setCookieConsent(choice));
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-consent-title"
      aria-live="polite"
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
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
            {t("title")}
          </p>
          <p style={{ margin: 0 }}>{t("body")} {" "}
            <a href="/privacy" style={{ color: "#a4e6ff", textDecoration: "underline" }}>{t("privacyLabel")}</a>
            {" · "}
            <a href="/cookies" style={{ color: "#a4e6ff", textDecoration: "underline" }}>{t("cookiesLabel")}</a></p>
        </div>
        {saveFailed && <p role="alert" style={{ margin: 0 }}>{t("saveFailed")}</p>}
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
            aria-label={t("essentialOnly")}
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
            {t("essentialOnly")}
          </button>
          <button
            type="button"
            onClick={() => decide("accepted")}
            aria-label={t("acceptAll")}
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
            {t("acceptAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
