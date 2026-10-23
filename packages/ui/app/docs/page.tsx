
import { useTranslations as useRuntimeTranslations } from "next-intl";
import { getTranslations as getSeoTranslations } from "next-intl/server";

import { useTranslations as useLegacyTranslations } from "next-intl";
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
import { DOCS_ORDERED, DOC_PILL, docCategoryLabel, localizeDoc, type DocCategory } from "./content";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("ma9faa242317f")),
  description:
    seo("m365f82802c67"),
  alternates: { canonical: "https://www.braavolabs.com/docs" },
  openGraph: {
    title: seo("mee84ba24e941"),
    description:
      seo("m50dcefa5f29a"),
    type: "website",
    url: "https://www.braavolabs.com/docs",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

const CATEGORY_ORDER: DocCategory[] = ["Start here", "Concepts", "Reference"];

export default function DocsIndexPage() {
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  const contentCopy = useLegacyTranslations("content");
  const docs = DOCS_ORDERED.map(doc => localizeDoc(doc, contentCopy));
  return (
    <div className="min-h-screen bg-background bv-mesh">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1100px] mx-auto flex flex-wrap gap-y-2 items-center justify-between px-6 md:px-10 min-h-14 py-2 md:py-0">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bv-btn-primary bv-btn">
              <span className="text-white font-bold text-xs leading-none">AI</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>
          <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6">
            <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m818b2a78eb90")}</a>
            <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m4cc1f3608ddc")}</a>
            <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mf6823057de7d")}</a>
            <a href="/docs" className="text-sm font-semibold text-primary no-underline">{uiText("m87eedb771754")}</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm no-underline">{uiText("mda5526776bb1")}</a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm text-sm no-underline">{uiText("md725474be468")}</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center pt-[clamp(56px,8vw,90px)] pb-10 overflow-hidden">
        <div className="relative max-w-[1100px] mx-auto px-6">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>menu_book</span>{uiText("m5aac6b035a43")}</span>
          </div>
          <h1 className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">{uiText("mc85715c7a4bb")}</h1>
          <p className="text-on-surface-variant max-w-[58ch] mx-auto">{uiText("m8f52d8cc2d59")}</p>
          <div className="flex flex-wrap justify-center gap-3 mt-8">
            <Link href="/docs/getting-started" className="bv-btn bv-btn-primary bv-btn-sm no-underline">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>{uiText("m20c340bf69ae")}</Link>
            <Link href="/docs/concepts" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>schema</span>{uiText("m602cdfb50800")}</Link>
            <Link href="/docs/faq" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>quiz</span>{uiText("m9a896a6ca8c2")}</Link>
          </div>
        </div>
      </header>

      {/* ── Category sections ── */}
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 pb-24">
        {CATEGORY_ORDER.map((cat) => {
          const pages = docs.filter((d) => d.category === cat);
          if (pages.length === 0) return null;
          return (
            <section key={docCategoryLabel(cat, contentCopy)} className="mb-12">
              <div className="flex items-center gap-3 mb-5">
                <h2 className="bv-micro" style={{ color: "var(--color-outline)" }}>
                  {docCategoryLabel(cat, contentCopy)}
                </h2>
                <div className="bv-divider flex-1" />
              </div>
              <div
                className="grid gap-5"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}
              >
                {pages.map((doc) => (
                  <Link
                    key={doc.slug}
                    href={`/docs/${doc.slug}`}
                    className="bv-glass flex flex-col p-6 cursor-pointer group no-underline"
                    aria-label={runtimeCopy("ma735f1949098", { value0: doc.title })}
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
                      <span className={DOC_PILL[doc.category]}>{docCategoryLabel(doc.category, contentCopy)}</span>
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
                    >{uiText("md4293b1a891b")}<span className="material-symbols-outlined" style={{ fontSize: 14 }}>
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
              <p className="text-sm text-on-surface-variant leading-relaxed">{uiText("mfa2b75fcfa90")}</p>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("mc06c8b9bd590")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m818b2a78eb90")}</a>
                <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m4cc1f3608ddc")}</a>
                <a href="/changelog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m9e4e062300ce")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("mdc663d5d4765")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/docs" className="text-sm text-primary hover:text-on-surface transition-colors no-underline">{uiText("m87eedb771754")}</a>
                <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mf6823057de7d")}</a>
                <a href="/support" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m698bc6e3f89e")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m975952c059f7")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mad1ae8839ed9")}</a>
                <a href="/contact" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m8d136db7d880")}</a>
                <a href="/status" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m2b43eb3b2c10")}</a>
              </div>
            </div>
          </div>
          <div className="bv-divider" />
          <p className="text-sm text-outline mt-6 text-center">{uiText("m22d2dde46b20")}</p>
        </div>
      </footer>
    </div>
  );
}
