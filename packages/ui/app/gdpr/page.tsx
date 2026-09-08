"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useEffect, useRef } from "react";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const sections = [
  {
    title: "Data Controller",
    body: "Braavolabs is the data controller for personal data processed through this platform. Contact: gdpr@braavolabs.com.",
  },
  {
    title: "Personal Data We Process",
    body: "Identity data (name, email, organization name), account data (subscription status, billing history), usage data (pipeline run records, audit logs, IP, session ID), and payment metadata when billing is enabled. The card-data handling boundary and records depend on the current payment provider and deployment; contact gdpr@braavolabs.com for the current details relevant to a verified request.",
  },
  {
    title: "Lawful Bases",
    body: "Article 6(1)(b) contract performance for service delivery and billing. Article 6(1)(f) legitimate interest for security, fraud prevention, and product improvement. Article 6(1)(c) legal obligation for tax and accounting. Article 6(1)(a) consent for optional marketing communication.",
  },
  {
    title: "Cross-Border Transfers",
    body: "Some processing may involve providers or infrastructure outside your jurisdiction. The current providers, destinations, and applicable legal safeguards depend on the active deployment and are not promised here without current provider and legal evidence. Contact gdpr@braavolabs.com for the current position relevant to a verified request.",
  },
  {
    title: "Your Rights",
    body: "You have the right to access, rectify, erase, restrict processing, port your data, object to processing, withdraw consent at any time, and lodge a complaint with your supervisory authority. To exercise any right, email gdpr@braavolabs.com — we respond within one month per Article 12(3).",
  },
  {
    title: "Retention",
    body: "Account data is retained while it is needed to provide the account. Other retention periods depend on current provider, deployment, and legal requirements and are communicated for a verified request rather than promised here as a fixed public schedule.",
  },
  {
    title: "Security",
    body: "Our published web proxy configuration supports TLS 1.2 and TLS 1.3 in transit. Other at-rest, production-access, security, and retention details are not promised here without current provider and deployment evidence.",
  },
  {
    title: "Data Protection Officer",
    body: "We have not appointed a formal DPO as we do not meet the Article 37 thresholds, but data protection inquiries are handled directly: gdpr@braavolabs.com.",
  },
];

export default function GdprPage() {
  // Page body stays English to match the supervisory-authority working
  // language; chrome localises and a banner notes the single-locale
  // design when a visitor arrives on a non-EN locale.
  const t = useTranslations();
  const legal = useTranslations("static.common.legalNavigation");
  const locale = useLocale();
  const showBanner = locale !== "en";

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
      className="min-h-screen bv-mesh"
      style={{ fontFamily: "var(--bv-font-body)" }}
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

        <div className="flex items-center gap-3">
          <a href="/" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
            {t("static.common.back")}
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
                display: "inline-flex",
                marginBottom: 20,
                padding: "10px 16px",
                fontSize: 12,
                color: "var(--color-on-surface-variant)",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>
              {t("static.singleLocale.gdprBanner")}
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
            className="bv-grad-text"
            style={{
              fontFamily: "var(--bv-font-display)",
              fontSize: "clamp(34px,5vw,60px)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            GDPR Statement
          </h1>

          <p
            className="bv-mono"
            style={{ color: "var(--color-outline)", marginTop: 12 }}
          >
            {t("static.common.lastUpdated")} May 2026
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
            top: 84,
            alignSelf: "start",
          }}
        >
          <p
            className="bv-micro"
            style={{ marginBottom: 14 }}
          >
            {legal("onThisPage")}
          </p>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {sections.map((section) => {
              const id = slugify(section.title);
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
                    fontFamily: "var(--bv-font-display)",
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
                    aria-label={legal("permalinkTo", { title: section.title })}
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
