"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { useLocale, useTranslations } from "next-intl";
import { useState, useEffect, useRef } from "react";

const SECTION_IDS = ["data-controller","personal-data","lawful-bases","cross-border-transfers","your-rights","retention","security","data-protection-contact"] as const;

export default function GdprPage() {
  const copy = useLegacyTranslations("surface");
  const sections = SECTION_IDS.map(id => ({ id, title: copy(`legal.gdpr.${id}.title`), body: copy(`legal.gdpr.${id}.body`) }));
  const uiText = useLegacyTranslations("uiCopy");
  // Every visitor sees the translated preview notice. Legal completion remains open.
  const t = useTranslations();
  const legal = useTranslations("static.common.legalNavigation");
  const locale = useLocale();
  const backLabel = t("static.common.back");
  const showBanner = true;
  const updatedMonth = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date("2026-10-20T00:00:00Z"));

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

  return (
    <div
      className="min-h-screen bv-mesh [--bv-legal-offset:140px] lg:[--bv-legal-offset:90px]"
      style={{ fontFamily: "var(--bv-font-body)" }}
    >
      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 px-6 md:px-10 py-3"
        style={{
          minHeight: "64px",
          background: "var(--color-surface-container-low)",
          backdropFilter: "blur(20px) saturate(1.1)",
          WebkitBackdropFilter: "blur(20px) saturate(1.1)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div
            className="bv-avatar"
            style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}
          >
            B
          </div>
          <span
            className="font-headline font-bold text-sm"
            style={{ color: "var(--color-on-surface)", fontFamily: "var(--bv-font-display)" }}
          >
            Braavolabs
          </span>
        </a>

        <div className="ms-auto flex flex-wrap items-center justify-end gap-3">
          <a href="/" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
            {locale === "ar" ? backLabel.replace(/^←/, "→") : backLabel}
          </a>
          <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm no-underline bv-legal-cta">
            {legal("openApp")}
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
          {/* Single-locale banner */}
          {showBanner && (
            <div
              className="bv-panel"
              style={{
                display: "flex",
                width: "fit-content",
                maxWidth: "100%",
                margin: "0 auto 20px",
                padding: "10px 16px",
                fontSize: 12,
                color: "var(--color-on-surface-variant)",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>
              {copy("legal.previewNotice")}
            </div>
          )}

          {/* Eyebrow */}
          <div
            className="bv-pill bv-pill-cyan"
            style={{ display: "inline-flex", marginBottom: 16, letterSpacing: "0.12em" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>gavel</span>
            {legal("legal")}
          </div>

          <h1
            lang={locale}
            dir={locale === "ar" ? "rtl" : "ltr"}
            className="bv-grad-text"
            style={{
              fontFamily: "var(--bv-font-display)",
              fontSize: "clamp(34px,5vw,60px)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >{copy("legal.gdprTitle")}</h1>

          <p
            className="bv-mono"
            style={{ color: "var(--color-outline)", marginTop: 12 }}
          >
            {t("static.common.lastUpdated")}{" "}<time dateTime="2026-10-20">{updatedMonth}</time>
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
              { key: "privacy", label: legal("privacy"), href: "/privacy" },
              { key: "terms", label: legal("terms"), href: "/terms" },
              { key: "cookies", label: legal("cookies"), href: "/cookies" },
              { key: "gdpr", label: "GDPR", href: "/gdpr" },
              { key: "kvkk", label: "KVKK", href: "/kvkk" },
              { key: "account-deletion", label: legal("accountDeletion"), href: "/legal/account-deletion" },
            ].map((doc) => (
              <a
                key={doc.key}
                href={doc.href}
                className={`bv-fpill${doc.key === "gdpr" ? " active" : ""}`}
                style={{ textDecoration: "none" }}
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
          aria-label={legal("onThisPage")}
          style={{
            position: "sticky",
            top: "var(--bv-legal-offset)",
            alignSelf: "start",
          }}
        >
          <p
            className="bv-micro"
            style={{ marginBottom: 14 }}
          >
            {legal("onThisPage")}
          </p>
          <div lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} style={{ display: "flex", flexDirection: "column" }}>
            {sections.map((section) => {
              const id = section.id;
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
                    borderInlineStart: isActive
                      ? "2px solid var(--color-primary)"
                      : "2px solid var(--bv-steel-shadow)",
                    transition: "color 0.25s, border-color 0.25s",
                    lineHeight: 1.3,
                  }}
                >
                  {section.title}
                </a>
              );
            })}
          </div>
        </nav>

        {/* Prose */}
        <article
          lang={locale}
          dir={locale === "ar" ? "rtl" : "ltr"}
          ref={proseRef}
          style={{ maxWidth: "72ch", paddingBottom: 0 }}
        >
          {sections.map((section, i) => {
            const id = section.id;
            return (
              <div key={id} style={{ marginTop: i === 0 ? 0 : 36 }}>
                <h2
                  id={id}
                  style={{
                    fontFamily: "var(--bv-font-display)",
                    fontSize: 24,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                    color: "var(--color-on-surface)",
                    margin: "0 0 14px 0",
                    scrollMarginTop: "var(--bv-legal-offset)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  {section.title}
                  <a
                    href={`#${id}`}
                    aria-label={legal("permalinkTo", { title: section.title })}
                    lang={locale}
                    dir={locale === "ar" ? "rtl" : "ltr"}
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
                {i < sections.length - 1 && (
                  <div
                    className="bv-divider"
                    style={{ marginTop: 36 }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
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
