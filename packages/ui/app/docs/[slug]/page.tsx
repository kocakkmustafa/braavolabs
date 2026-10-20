
import { getTranslations as getLegacyTranslations } from "next-intl/server";
import { useTranslations as useLegacyTranslations } from "next-intl";
/**
 * Docs article page — The Manual.
 *
 * Server component, statically generated for every page in app/docs/content.ts.
 * Content is a typed block array rendered by the exhaustive switch in
 * <Block/> — plain React nodes only, no HTML injection. The FAQ page also
 * emits FAQPage JSON-LD (application/ld+json) for SEO / answer-engine
 * discovery; the JSON is built from the same typed FAQ items, so the structured
 * data can never drift from the rendered copy.
 *
 * Shared nav + footer markup is copied from the marketing pages — this route
 * owns no shared components and edits none.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DOCS,
  DOCS_ORDERED,
  DOC_PILL,
  faqItemsOf,
  getDoc,
  localizeDoc,
  docCategoryLabel,
  type DocBlock,
  type DocPage,
} from "../content";

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const contentCopy = await getLegacyTranslations("content");
  const baseDoc = getDoc(slug);
  if (!baseDoc) return { title: "Braavolabs" };
  const doc = localizeDoc(baseDoc, contentCopy);
  return {
    title: `${doc.title} — Braavolabs Docs`,
    description: doc.desc,
    alternates: { canonical: `https://www.braavolabs.com/docs/${slug}` },
    openGraph: {
      title: `${doc.title} — Braavolabs Docs`,
      description: doc.desc,
      type: "article",
      url: `https://www.braavolabs.com/docs/${slug}`,
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
  };
}

/* ── Block renderer (exhaustive over DocBlock["kind"]) ───────────────────── */

function Block({ block }: { block: DocBlock }) {
  const legal = useLegacyTranslations("static.common.legalNavigation");
  switch (block.kind) {
    case "heading":
      return (
        <h2
          id={block.id}
          className="font-headline font-semibold uppercase tracking-tight text-on-surface scroll-mt-[90px] flex items-center gap-[10px] group"
          style={{ fontSize: 22, marginTop: 40, marginBottom: 14 }}
        >
          <span>{block.text}</span>
          <a
            href={`#${block.id}`}
            className="opacity-0 group-hover:opacity-100 text-[15px] text-primary no-underline transition-opacity"
            aria-label={legal("permalinkTo", { title: block.text })}
          >
            ¶
          </a>
        </h2>
      );

    case "para":
      return (
        <p style={{ color: "var(--color-on-surface-variant)", fontSize: 16, lineHeight: 1.8, margin: "0 0 18px" }}>
          {block.text}
        </p>
      );

    case "list":
      return (
        <ul style={{ margin: "0 0 18px", paddingInlineStart: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          {block.items.map((it, j) => (
            <li key={j} style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "var(--color-on-surface-variant)", fontSize: 16, lineHeight: 1.75 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: "#3B82F6", marginTop: 9, flexShrink: 0, boxShadow: "0 0 8px #3B82F6", display: "inline-block" }} />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      );

    case "steps":
      return (
        <ol style={{ margin: "0 0 18px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14, counterReset: "bv-step" }}>
          {block.items.map((it, j) => (
            <li key={j} className="bv-glass" style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "16px 18px", borderRadius: 14 }}>
              <span
                className="bv-numeric flex-shrink-0"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  color: "var(--color-primary)",
                  background: "rgba(59,130,246,0.10)",
                  border: "1px solid rgba(59,130,246,0.22)",
                }}
              >
                {j + 1}
              </span>
              <div>
                <p className="bv-title" style={{ color: "var(--color-on-surface)", marginBottom: 4, fontSize: 15.5 }}>
                  {it.title}
                </p>
                <p style={{ color: "var(--color-on-surface-variant)", fontSize: 14.5, lineHeight: 1.7, margin: 0 }}>
                  {it.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      );

    case "code":
      return (
        <figure style={{ margin: "0 0 20px" }}>
          {block.caption && (
            <figcaption
              className="bv-mono"
              style={{
                fontSize: 11,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--color-outline)",
                marginBottom: 8,
              }}
            >
              {block.caption}
            </figcaption>
          )}
          <pre
            style={{
              margin: 0,
              padding: "16px 18px",
              borderRadius: 14,
              background: "var(--color-surface-container-low)",
              border: "1px solid rgba(58,65,80,0.5)",
              overflowX: "auto",
            }}
          >
            <code
              className="bv-mono"
              style={{ fontSize: 13, lineHeight: 1.7, color: "#C7D0DE", whiteSpace: "pre" }}
            >
              {block.code}
            </code>
          </pre>
        </figure>
      );

    case "note": {
      const warn = block.tone === "warn";
      return (
        <div
          className="bv-glass"
          style={{
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            padding: "14px 16px",
            borderRadius: 14,
            margin: "0 0 20px",
            border: `1px solid ${warn ? "rgba(255,122,26,0.30)" : "rgba(59,130,246,0.25)"}`,
          }}
        >
          <span
            className="material-symbols-outlined flex-shrink-0"
            style={{ fontSize: 18, color: warn ? "#FF7A1A" : "var(--color-primary)", marginTop: 1 }}
            aria-hidden="true"
          >
            {warn ? "warning" : "info"}
          </span>
          <p style={{ color: "var(--color-on-surface-variant)", fontSize: 14.5, lineHeight: 1.7, margin: 0 }}>
            {block.text}
          </p>
        </div>
      );
    }

    case "faq":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, margin: "8px 0 18px" }}>
          {block.items.map((it, j) => (
            <div key={j} className="bv-glass" style={{ padding: "18px 20px", borderRadius: 14 }}>
              <p className="bv-title" style={{ color: "var(--color-on-surface)", marginBottom: 8, fontSize: 16 }}>
                {it.q}
              </p>
              <p style={{ color: "var(--color-on-surface-variant)", fontSize: 15, lineHeight: 1.75, margin: 0 }}>
                {it.a}
              </p>
            </div>
          ))}
        </div>
      );
  }
}

/** Collect heading blocks for the on-this-page TOC. */
function headingsOf(doc: DocPage) {
  return doc.blocks.flatMap((b) => (b.kind === "heading" ? [{ id: b.id, text: b.text }] : []));
}

export default async function DocsArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const uiText = await getLegacyTranslations("uiCopy");
  const { slug } = await params;
  const contentCopy = await getLegacyTranslations("content");
  const baseDoc = getDoc(slug);
  if (!baseDoc) notFound();
  const doc = localizeDoc(baseDoc, contentCopy);
  const docs = DOCS_ORDERED.map(page => localizeDoc(page, contentCopy));

  const headings = headingsOf(doc);
  const faqItems = faqItemsOf(doc);

  // Prev / next in reading order.
  const idx = docs.findIndex((d) => d.slug === doc.slug);
  const prev = idx > 0 ? docs[idx - 1] : undefined;
  const next = idx < docs.length - 1 ? docs[idx + 1] : undefined;

  // FAQPage structured data — built from the same typed items the page renders.
  const faqJsonLd =
    faqItems.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqItems.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
          })),
        }
      : null;

  return (
    <div className="min-h-screen bg-background bv-mesh">
      {faqJsonLd && (
        // Static, build-time JSON-LD from trusted in-repo content (no user input).
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c") }}
        />
      )}

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
            <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mb34c85aff53f")}</a>
            <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m85a856ab28be")}</a>
            <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mdd91fe0b7fc0")}</a>
            <a href="/docs" className="text-sm font-semibold text-primary no-underline">{uiText("m6179659c73b9")}</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm no-underline">{uiText("m35127686df60")}</a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm text-sm no-underline">{uiText("m5b83c05ccb0c")}</a>
          </div>
        </div>
      </nav>

      {/* ── Layout: side nav + prose ── */}
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 pt-12 mb-24 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-12">
        {/* Side nav: all docs (desktop) */}
        <nav className="hidden md:block sticky top-[72px] self-start" aria-label={uiText("mcb951cf4a4d3")}>
          <p className="bv-micro mb-[14px]">{uiText("m0c14fdc4a1c6")}</p>
          <div className="flex flex-col mb-8">
            {docs.map((d) => {
              const active = d.slug === doc.slug;
              return (
                <Link
                  key={d.slug}
                  href={`/docs/${d.slug}`}
                  className={`text-[13px] leading-[1.3] py-[7px] px-[14px] border-l-2 transition-all no-underline ${
                    active
                      ? "text-on-surface border-primary font-medium"
                      : "text-on-surface-variant hover:text-on-surface border-outline-variant hover:border-primary"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  {d.nav}
                </Link>
              );
            })}
          </div>

          {headings.length > 0 && (
            <>
              <p className="bv-micro mb-[14px]">{uiText("m6c77f98962d7")}</p>
              <div className="flex flex-col">
                {headings.map((h) => (
                  <a
                    key={h.id}
                    href={`#${h.id}`}
                    className="text-[13px] leading-[1.3] text-on-surface-variant hover:text-on-surface py-[6px] px-[14px] border-l-2 border-outline-variant hover:border-primary transition-all no-underline"
                  >
                    {h.text}
                  </a>
                ))}
              </div>
            </>
          )}
        </nav>

        {/* Prose */}
        <article className="max-w-[72ch] bv-stagger">
          <Link
            href="/docs"
            className="bv-mono inline-flex items-center gap-2 mb-6"
            style={{ fontSize: 12, color: "var(--color-primary)", textDecoration: "none", letterSpacing: "0.08em" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>arrow_back</span>{uiText("m0c14fdc4a1c6")}</Link>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <span className={DOC_PILL[doc.category]}>{docCategoryLabel(doc.category, contentCopy)}</span>
          </div>

          <h1
            className="bv-display"
            style={{ fontSize: "clamp(30px, 4.5vw, 44px)", lineHeight: 1.08, letterSpacing: "-0.015em", color: "var(--color-on-surface)", marginBottom: 14 }}
          >
            {doc.title}
          </h1>
          <p style={{ color: "var(--color-on-surface-variant)", fontSize: 18, lineHeight: 1.7, marginBottom: 32 }}>{doc.desc}</p>

          <div className="bv-divider" style={{ marginBottom: 28 }} />

          {doc.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}

          {/* ── Prev / next ── */}
          <div className="grid gap-4 mt-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {prev ? (
              <Link href={`/docs/${prev.slug}`} className="bv-glass rounded-2xl px-5 py-4 no-underline">
                <span className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)", letterSpacing: "0.08em" }}>{uiText("m074fdba85cf1")}</span>
                <p className="bv-title" style={{ color: "var(--color-on-surface)", margin: "6px 0 0", fontSize: 15 }}>{prev.title}</p>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={`/docs/${next.slug}`} className="bv-glass rounded-2xl px-5 py-4 no-underline" style={{ textAlign: "end" }}>
                <span className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)", letterSpacing: "0.08em" }}>{uiText("m1388671ac3bc")}</span>
                <p className="bv-title" style={{ color: "var(--color-on-surface)", margin: "6px 0 0", fontSize: 15 }}>{next.title}</p>
              </Link>
            )}
          </div>

          {/* ── CTA ── */}
          <div className="bv-glass rounded-2xl px-7 py-7 mt-10 flex items-center gap-5 flex-wrap" style={{ border: "1px solid rgba(59,130,246,0.25)" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <p className="bv-title" style={{ color: "var(--color-on-surface)", marginBottom: 4 }}>{uiText("m90aeded95734")}</p>
              <p className="bv-caption" style={{ margin: 0 }}>{uiText("mf8873bd65493")}</p>
            </div>
            <Link href="https://app.braavolabs.com" className="bv-btn bv-btn-primary no-underline">{uiText("m5b83c05ccb0c")}</Link>
          </div>
        </article>
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
              <p className="text-sm text-on-surface-variant leading-relaxed">{uiText("m906152f47b4f")}</p>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m1ec39ca165b6")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mb34c85aff53f")}</a>
                <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m85a856ab28be")}</a>
                <a href="/changelog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mbb3043a7f2cf")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m50200f20c520")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/docs" className="text-sm text-primary hover:text-on-surface transition-colors no-underline">{uiText("m6179659c73b9")}</a>
                <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mdd91fe0b7fc0")}</a>
                <a href="/support" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m35fa61443236")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m6ea06edad850")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m7f7a851ede21")}</a>
                <a href="/contact" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("mebaef44626be")}</a>
                <a href="/status" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors no-underline">{uiText("m07c7e04fadf1")}</a>
              </div>
            </div>
          </div>
          <div className="bv-divider" />
          <p className="text-sm text-outline mt-6 text-center">{uiText("m7375dacc55cd")}</p>
        </div>
      </footer>
    </div>
  );
}
