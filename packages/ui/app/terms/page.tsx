"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect, useRef } from "react";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const DOC_KEYS = ["privacy", "terms", "cookies", "gdpr", "kvkk", "deletion"] as const;
type DocKey = (typeof DOC_KEYS)[number];

const DOC_LABELS: Record<DocKey, string> = {
  privacy: "Privacy",
  terms: "Terms",
  cookies: "Cookies",
  gdpr: "GDPR",
  kvkk: "KVKK",
  deletion: "Account Deletion",
};

export default function TermsPage() {
  const t = useTranslations();
  const sections = t.raw("static.legal.terms.sections") as Array<{ title: string; body: string }>;

  const [activeDoc, setActiveDoc] = useState<DocKey>("terms");
  const [activeSection, setActiveSection] = useState<string>("");
  const articleRef = useRef<HTMLElement>(null);

  // Scroll-spy
  useEffect(() => {
    const onScroll = () => {
      if (!articleRef.current) return;
      const headings = Array.from(articleRef.current.querySelectorAll("h2[id]")) as HTMLElement[];
      let current = "";
      for (const h of headings) {
        if (h.getBoundingClientRect().top < 150) current = h.id;
      }
      setActiveSection(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-background bv-mesh">
      {/* Skip link */}
      <a href="#main-content" className="skip-link">Skip to content</a>

      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-50 glass-panel"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>
              AI
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>

          <div className="hidden md:flex items-center gap-6">
            {(["Features", "Pricing", "About", "Changelog"] as const).map((label) => (
              <a
                key={label}
                href={`/${label.toLowerCase()}`}
                className="text-sm text-on-surface-variant hover:text-on-surface transition-colors"
              >
                {label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm">
              Sign in
            </a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm bv-sheen">
              Open app
            </a>
          </div>
        </div>
      </nav>

      {/* ── Page head ── */}
      <header className="relative pt-20 pb-10 text-center overflow-hidden">
        {/* watermark */}
        <div
          className="absolute left-1/2 top-8 -translate-x-1/2 w-60 aspect-square opacity-[0.04] pointer-events-none"
          style={{
            WebkitMaskImage: "radial-gradient(circle, #000 60%, transparent 74%)",
            maskImage: "radial-gradient(circle, #000 60%, transparent 74%)",
          }}
          aria-hidden
        >
          <div className="w-full h-full rounded-full gradient-brand" />
        </div>

        <div className="relative max-w-[1100px] mx-auto px-6">
          {/* eyebrow */}
          <div className="inline-flex items-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
                gavel
              </span>
              Legal
            </span>
          </div>

          <h1 className="bv-display text-on-surface uppercase tracking-tight mb-3">
            {activeDoc === "terms"
              ? t("static.legal.terms.title")
              : DOC_LABELS[activeDoc]}
          </h1>

          <p className="bv-mono text-on-surface-variant mb-8">
            Last updated{" "}
            {activeDoc === "terms" ? t("static.legal.terms.date") : "June 1, 2026"}
          </p>

          {/* doc switcher */}
          <div className="flex flex-wrap justify-center gap-2">
            {DOC_KEYS.map((key) => (
              <button
                key={key}
                onClick={() => {
                  setActiveDoc(key);
                  window.scrollTo({ top: 0 });
                }}
                className={`bv-fpill ${activeDoc === key ? "active" : ""}`}
              >
                {DOC_LABELS[key]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ── Article grid: TOC + prose ── */}
      <main
        id="main-content"
        className="max-w-[1040px] mx-auto px-6 md:px-8 pb-28"
        style={{ display: "grid", gridTemplateColumns: "230px 1fr", gap: 48, marginTop: 40 }}
      >
        {/* TOC — sticky sidebar */}
        <nav
          className="hidden md:block"
          style={{ position: "sticky", top: 84, alignSelf: "start" }}
          aria-label="On this page"
        >
          <p className="bv-micro mb-3">On this page</p>
          <div className="flex flex-col">
            {sections.map(({ title }) => {
              const id = slugify(title);
              const isActive = activeSection === id;
              return (
                <a
                  key={id}
                  href={`#${id}`}
                  className="text-sm py-2 px-3 transition-colors"
                  style={{
                    borderLeft: `2px solid ${isActive ? "#60A5FA" : "rgba(58,65,80,0.6)"}`,
                    color: isActive ? "#E8EBF0" : "#9AA3B2",
                    lineHeight: 1.3,
                    textDecoration: "none",
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
          ref={articleRef}
          className="pb-20 bv-stagger"
          style={{ maxWidth: "72ch" }}
        >
          {activeDoc === "terms" ? (
            /* Render from i18n keys when on the "terms" doc */
            sections.map(({ title, body }) => {
              const id = slugify(title);
              return (
                <section key={id} className="mb-8">
                  <h2
                    id={id}
                    className="bv-headline text-on-surface uppercase mb-3 flex items-center gap-2 group"
                    style={{ scrollMarginTop: 90, fontSize: 20 }}
                  >
                    {title}
                    <a
                      href={`#${id}`}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-primary"
                      style={{ fontSize: 14, textDecoration: "none" }}
                      aria-label={`Link to ${title}`}
                    >
                      ¶
                    </a>
                  </h2>
                  <p className="text-on-surface-variant leading-relaxed" style={{ fontSize: 15.5, lineHeight: 1.8 }}>
                    {body}
                  </p>
                  <div className="bv-divider mt-8" />
                </section>
              );
            })
          ) : (
            /* Placeholder prose for other docs — same visual treatment */
            <div className="bv-glass p-8 text-center text-on-surface-variant">
              <span className="material-symbols-outlined mb-4 block text-on-surface-variant" style={{ fontSize: 40 }}>
                description
              </span>
              <p className="bv-body">
                The <strong className="text-on-surface">{DOC_LABELS[activeDoc]}</strong> document is available at{" "}
                <a href={`/${activeDoc}`} className="text-primary hover:underline">
                  braavolabs.com/{activeDoc}
                </a>
                .
              </p>
            </div>
          )}
        </article>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2.5 mb-3">
                <div className="bv-avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 11 }}>
                  AI
                </div>
                <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
              </a>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                Command the AI agents &amp; automations you already run.
              </p>
            </div>

            {(
              [
                { heading: "Product", links: [["Features", "/features"], ["Pricing", "/pricing"], ["Changelog", "/changelog"]] },
                { heading: "Company", links: [["About", "/about"], ["Blog", "/blog"], ["Contact", "/contact"]] },
                {
                  heading: "Legal",
                  links: DOC_KEYS.map((k) => [DOC_LABELS[k], `/${k}`] as [string, string]),
                },
              ] as Array<{ heading: string; links: [string, string][] }>
            ).map(({ heading, links }) => (
              <div key={heading}>
                <h5 className="bv-micro mb-3">{heading}</h5>
                <div className="flex flex-col gap-2">
                  {links.map(([label, href]) => (
                    <a
                      key={label}
                      href={href}
                      className="text-sm text-on-surface-variant hover:text-on-surface transition-colors"
                    >
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="bv-divider mb-6" />
          <p className="text-sm text-on-surface-variant text-center">
            &copy; {new Date().getFullYear()} Braavolabs. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
