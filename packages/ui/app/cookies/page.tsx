"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { clearCookieConsent, getCookieConsent } from "../../components/CookieConsent";

// Withdrawal copy is intentionally not threaded through next-intl yet —
// keys would need to ship in all 6 locale files. The bilingual fallback
// here covers the realistic visitor mix until the localisation pipeline
// catches up. KVKK Article 11 / GDPR Article 7(3) only requires that
// withdrawal be no harder than consent, not that copy match exactly.
const PREFERENCES_COPY: Record<"tr" | "en", { title: string; body: string; button: string; confirmation: string }> = {
  en: {
    title: "Manage your preferences",
    body:
      "You can withdraw your previous choice at any time. Clicking the button below clears the stored decision and re-shows the consent banner.",
    button: "Reset cookie preferences",
    confirmation: "Your preferences have been cleared. The banner will reappear on the next page view.",
  },
  tr: {
    title: "Tercihlerini yönet",
    body:
      "Daha önce verdiğin onayı istediğin zaman geri alabilirsin. Aşağıdaki butona tıklayınca kayıtlı tercih silinir ve onay penceresi yeniden görünür.",
    button: "Çerez tercihlerini sıfırla",
    confirmation: "Tercihlerin silindi. Bir sonraki sayfa açılışında onay penceresi tekrar görünecek.",
  },
};

export default function CookiesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const sections = t.raw("static.legal.cookies.sections") as Array<{ title: string; body: string }>;
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const copy = PREFERENCES_COPY[locale === "tr" ? "tr" : "en"];

  function handleReset() {
    clearCookieConsent();
    setResetMessage(getCookieConsent() === null ? "ok" : "noop");
  }

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <a href="/" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>{t("static.common.back")}</a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-16">
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>{t("static.legal.cookies.title")}</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>{t("static.common.lastUpdated")} {t("static.legal.cookies.date")}</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>{section.title}</h2>
              <p>{section.body}</p>
            </div>
          ))}

          <div
            style={{
              marginTop: 24,
              padding: 16,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>
              {copy.title}
            </h2>
            <p style={{ marginBottom: 12 }}>{copy.body}</p>
            <button
              type="button"
              onClick={handleReset}
              style={{
                padding: "10px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.04)",
                color: "#e1e2eb",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {copy.button}
            </button>
            {resetMessage === "ok" && (
              <p style={{ marginTop: 8, color: "#7be39c" }}>{copy.confirmation}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
