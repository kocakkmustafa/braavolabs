/**
 * Docs index — The Manual.
 *
 * Server component. Lists every doc page from app/docs/content.ts, grouped by
 * category, with the shared FORGE nav + footer (copied from the marketing
 * pages — this route owns no shared markup). Each card links to
 * /docs/<slug>, which is statically generated in [slug]/page.tsx.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { DOCS_ORDERED, DOC_PILL, type DocCategory } from "./content";

export const metadata: Metadata = {
  title: "Docs — Braavolabs",
  description:
    "Braavolabs documentation: getting started, BYOK setup for 14 providers, mid-run steering, webhooks, external automation connections, the mobile app, and FAQ.",
  alternates: { canonical: "https://braavolabs.com/docs" },
  openGraph: {
    title: "Braavolabs Docs",
    description:
      "Everything you need to compose, run, and govern an autonomous AI company — getting started, BYOK, steering, webhooks and more.",
    type: "website",
    url: "https://braavolabs.com/docs",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

const CATEGORY_ORDER: DocCategory[] = ["Start here", "Concepts", "Reference"];

export default function DocsIndexPage() {
  return (
    <div className="min-h-screen bg-background bv-mesh">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-10 h-14">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bv-btn-primary bv-btn">
              <span className="text-white font-bold text-xs leading-none">AI</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>
          <div className="hidden md:flex items-center gap-6">
            <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Features</a>
            <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Pricing</a>
            <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Blog</a>
            <a href="/docs" className="text-sm font-semibold text-primary no-underline">Docs</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm no-underline">Sign in</a>
            <a href="/register" className="bv-btn bv-btn-primary bv-btn-sm text-sm no-underline">Start free</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center pt-[clamp(56px,8vw,90px)] pb-10 overflow-hidden">
        <div className="relative max-w-[1100px] mx-auto px-6">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>menu_book</span>
              The Manual
            </span>
          </div>
          <h1 className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">
            Documentation
          </h1>
          <p className="text-on-surface-variant max-w-[58ch] mx-auto">
            How to compose, run, and govern an autonomous AI company — from your
            first run to webhooks, on-device models, and steering agents from
            your phone.
          </p>
          <div className="flex flex-wrap justify-center gap-3 mt-8">
            <Link href="/docs/getting-started" className="bv-btn bv-btn-primary bv-btn-sm no-underline">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
              Getting started
            </Link>
            <Link href="/docs/concepts" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>schema</span>
              Core concepts
            </Link>
            <Link href="/docs/faq" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>quiz</span>
              FAQ
            </Link>
          </div>
        </div>
      </header>

      {/* ── Category sections ── */}
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 pb-24">
        {CATEGORY_ORDER.map((cat) => {
          const pages = DOCS_ORDERED.filter((d) => d.category === cat);
          if (pages.length === 0) return null;
          return (
            <section key={cat} className="mb-12">
              <div className="flex items-center gap-3 mb-5">
                <h2 className="bv-micro" style={{ color: "var(--color-outline)" }}>
                  {cat}
                </h2>
                <div className="bv-divider flex-1" />
              </div>
              <div
                className="grid gap-5"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
              >
                {pages.map((doc) => (
                  <Link
                    key={doc.slug}
                    href={`/docs/${doc.slug}`}
                    className="bv-glass flex flex-col p-6 cursor-pointer group no-underline"
                    aria-label={`Read docs: ${doc.title}`}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                        style={{
                          background: "rgba(59,130,246,0.10)",
                          border: "1px solid rgba(59,130,246,0.22)",
                        }}
                      >
                        <span
                          className="material-symbols-outlined"
                          style={{ fontSize: 20, color: "var(--color-primary)" }}
                        >
                          {doc.icon}
                        </span>
                      </div>
                      <span className={DOC_PILL[doc.category]}>{doc.category}</span>
                    </div>
                    <h3
                      className="font-headline font-bold mb-2 group-hover:text-primary transition-colors"
                      style={{
                        fontSize: 17,
                        lineHeight: 1.15,
                        letterSpacing: "-0.005em",
                        color: "var(--color-on-surface)",
                      }}
                    >
                      {doc.title}
                    </h3>
                    <p
                      className="flex-1 leading-relaxed"
                      style={{
                        color: "var(--color-on-surface-variant)",
                        fontSize: 13,
                        lineHeight: 1.55,
                      }}
                    >
                      {doc.desc}
                    </p>
                    <div
                      className="bv-mono flex items-center gap-1 mt-4 group-hover:text-primary transition-colors"
                      style={{ color: "var(--color-outline)", fontSize: 12 }}
                    >
                      Read
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                        arrow_forward
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2.5 mb-3 no-underline">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center bv-btn-primary bv-btn bv-btn-icon" style={{ padding: 0, minWidth: 28, minHeight: 28, width: 28, height: 28 }}>
                  <span className="text-white font-bold text-[10px] leading-none">AI</span>
                </div>
                <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
              </a>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                Command the AI agents &amp; automations you already run.
              </p>
            </div>
            <div>
              <h5 className="bv-micro mb-3">Product</h5>
              <div className="flex flex-col gap-2">
                <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Features</a>
                <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Pricing</a>
                <a href="/changelog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Changelog</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">Resources</h5>
              <div className="flex flex-col gap-2">
                <a href="/docs" className="text-sm text-primary hover:text-on-surface transition-colors no-underline">Docs</a>
                <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Blog</a>
                <a href="/support" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Support</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">Company</h5>
              <div className="flex flex-col gap-2">
                <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">About</a>
                <a href="/contact" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Contact</a>
                <a href="/status" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">Status</a>
              </div>
            </div>
          </div>
          <div className="bv-divider" />
          <p className="text-sm text-outline mt-6 text-center">
            &copy; 2026 Braavolabs. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
