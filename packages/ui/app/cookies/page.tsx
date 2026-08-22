"use client";

import { useState, useEffect, useRef } from "react";
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

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export default function CookiesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const sections = t.raw("static.legal.cookies.sections") as Array<{ title: string; body: string }>;
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const copy = PREFERENCES_COPY[locale === "tr" ? "tr" : "en"];

  const [activeSection, setActiveSection] = useState<string>("");
  const proseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleScroll = () => {
      if (!proseRef.current) return;
      const headings = proseRef.current.querySelectorAll<HTMLElement>("h2[id]");
      let current = "";
      headings.forEach((h) => {
        if (h.getBoundingClientRect().top < 150) current = h.id;
      });
      setActiveSection(current);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  function handleReset() {
    clearCookieConsent();
    setResetMessage(getCookieConsent() === null ? "ok" : "noop");
  }

  // TOC includes the preferences section as a virtual entry
  const prefId = slugify(copy.title);
  const allTocSections = [
    ...sections.map((s) => ({ id: slugify(s.title), title: s.title })),
    { id: prefId, title: copy.title },
  ];

  return (
    <div
      className="min-h-screen mesh-bg"
      style={{ fontFamily: "var(--font-body)" }}
    >
      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-50 flex items-center justify-between px-6 md:px-10"
        style={{
          height: "64px",
          background: "rgba(6,7,10,0.85)",
          backdropFilter: "blur(20px) saturate(1.1)",
          WebkitBackdropFilter: "blur(20px) saturate(1.1)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: "linear-gradient(135deg, var(--color-primary), var(--color-secondary-container))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              color: "#fff",
            }}
          >
            B
          </div>
          <span
            className="font-headline font-bold text-sm"
            style={{ color: "var(--color-on-surface)" }}
          >
            Braavolabs
          </span>
        </a>

        <div className="flex items-center gap-3">
          <a
            href="/"
            className="flex items-center gap-1.5 no-underline text-sm transition-colors"
            style={{ color: "var(--color-on-surface-variant)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
            {t("static.common.back")}
          </a>
          <a
            href="https://app.braavolabs.com/register"
            className="no-underline text-sm font-semibold px-4 py-2 rounded-lg"
            style={{
              background: "linear-gradient(135deg, var(--color-primary), var(--color-secondary-container))",
              color: "#fff",
            }}
          >
            Choose a plan
          </a>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center" style={{ paddingTop: "clamp(56px,8vw,90px)", paddingBottom: 0 }}>
        {/* Watermark glow */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "50%",
            top: "10%",
            transform: "translateX(-50%)",
            width: 280,
            height: 280,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(59,130,246,0.06) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "0 32px", position: "relative" }}>
          {/* Eyebrow */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 16,
              padding: "4px 12px",
              borderRadius: 999,
              border: "1px solid rgba(59,130,246,0.25)",
              background: "rgba(59,130,246,0.08)",
              color: "var(--color-primary)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>gavel</span>
            Legal
          </div>

          <h1
            className="gradient-text"
            style={{
              fontFamily: "var(--font-headline)",
              fontSize: "clamp(34px,5vw,60px)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            {t("static.legal.cookies.title")}
          </h1>

          <p
            style={{
              fontFamily: "monospace",
              fontSize: 12,
              color: "var(--color-outline)",
              marginTop: 12,
            }}
          >
            {t("static.common.lastUpdated")} {t("static.legal.cookies.date")}
          </p>

          {/* Doc switcher pills */}
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "center",
              marginTop: 22,
              marginBottom: 0,
            }}
          >
            {[
              { key: "privacy", label: "Privacy", href: "/privacy" },
              { key: "terms", label: "Terms", href: "/terms" },
              { key: "cookies", label: "Cookies", href: "/cookies" },
              { key: "gdpr", label: "GDPR", href: "/gdpr" },
              { key: "kvkk", label: "KVKK", href: "/kvkk" },
              { key: "account-deletion", label: "Account deletion", href: "/account-deletion" },
            ].map((doc) => (
              <a
                key={doc.key}
                href={doc.href}
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: doc.key === "cookies" ? "rgba(59,130,246,0.12)" : "var(--color-surface-container)",
                  border: doc.key === "cookies" ? "1px solid var(--color-primary)" : "1px solid var(--color-outline-variant)",
                  color: doc.key === "cookies" ? "#fff" : "var(--color-on-surface-variant)",
                  textDecoration: "none",
                  transition: "border-color 0.2s, color 0.2s",
                }}
              >
                {doc.label}
              </a>
            ))}
          </div>
        </div>
      </header>

      {/* ── Two-column legal layout ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "230px 1fr",
          gap: 48,
          maxWidth: 1040,
          margin: "40px auto 0",
          padding: "0 32px 100px",
        }}
        className="legal-grid"
      >
        {/* Sticky TOC */}
        <nav
          aria-label="On this page"
          style={{
            position: "sticky",
            top: 84,
            alignSelf: "start",
          }}
        >
          <p
            style={{
              fontFamily: "monospace",
              fontSize: 10,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--color-outline)",
              marginBottom: 14,
            }}
          >
            On this page
          </p>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {allTocSections.map(({ id, title }) => {
              const isActive = activeSection === id;
              return (
                <a
                  key={id}
                  href={`#${id}`}
                  style={{
                    display: "block",
                    color: isActive ? "var(--color-on-surface)" : "var(--color-on-surface-variant)",
                    textDecoration: "none",
                    fontSize: 13,
                    padding: "7px 0 7px 14px",
                    borderLeft: isActive
                      ? "2px solid var(--color-primary)"
                      : "2px solid var(--color-outline-variant)",
                    transition: "color 0.25s, border-color 0.25s",
                    lineHeight: 1.3,
                  }}
                >
                  {title}
                </a>
              );
            })}
          </div>
        </nav>

        {/* Prose */}
        <article
          ref={proseRef}
          style={{ maxWidth: "72ch", paddingBottom: 0 }}
        >
          {sections.map((section, i) => {
            const id = slugify(section.title);
            return (
              <div key={id} style={{ marginTop: i === 0 ? 0 : 36 }}>
                <h2
                  id={id}
                  style={{
                    fontFamily: "var(--font-headline)",
                    fontSize: 24,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                    color: "var(--color-on-surface)",
                    margin: "0 0 14px 0",
                    scrollMarginTop: 90,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  {section.title}
                  <a
                    href={`#${id}`}
                    aria-label={`Permalink to ${section.title}`}
                    className="section-anchor"
                    style={{
                      opacity: 0,
                      fontSize: 15,
                      color: "var(--color-primary)",
                      textDecoration: "none",
                      transition: "opacity 0.2s",
                    }}
                  >
                    ¶
                  </a>
                </h2>
                <p
                  style={{
                    color: "var(--color-on-surface-variant)",
                    fontSize: 15.5,
                    lineHeight: 1.8,
                    margin: "0 0 18px 0",
                  }}
                >
                  {section.body}
                </p>
                <div
                  style={{
                    borderTop: "1px solid var(--color-outline-variant)",
                    marginTop: 36,
                  }}
                  aria-hidden="true"
                />
              </div>
            );
          })}

          {/* ── Preferences card ── */}
          <div
            id={prefId}
            style={{
              marginTop: 36,
              padding: 20,
              borderRadius: 12,
              border: "1px solid var(--color-outline-variant)",
              background: "var(--color-surface-container)",
              scrollMarginTop: 90,
            }}
          >
            <h2
              style={{
                fontFamily: "var(--font-headline)",
                fontSize: 24,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "-0.01em",
                color: "var(--color-on-surface)",
                margin: "0 0 14px 0",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--color-primary)" }}>
                tune
              </span>
              {copy.title}
            </h2>

            <p
              style={{
                color: "var(--color-on-surface-variant)",
                fontSize: 15.5,
                lineHeight: 1.8,
                margin: "0 0 16px 0",
              }}
            >
              {copy.body}
            </p>

            <button
              type="button"
              onClick={handleReset}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 18px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid var(--color-outline-variant)",
                background: "var(--color-surface-container-high)",
                color: "var(--color-on-surface)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                transition: "border-color 0.2s, background 0.2s",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                cookie
              </span>
              {copy.button}
            </button>

            {resetMessage === "ok" && (
              <p
                style={{
                  marginTop: 12,
                  fontSize: 13,
                  color: "#4ade80",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>
                {copy.confirmation}
              </p>
            )}
          </div>
        </article>
      </div>

      {/* Responsive: hide TOC on mobile */}
      <style>{`
        @media (max-width: 820px) {
          .legal-grid {
            grid-template-columns: 1fr !important;
          }
          .legal-grid > nav {
            display: none !important;
          }
        }
        h2:hover .section-anchor {
          opacity: 1 !important;
        }
      `}</style>
    </div>
  );
}
