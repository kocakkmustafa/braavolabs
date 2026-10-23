
import { getLocale, getTranslations as getLegacyTranslations } from "next-intl/server";
/**
 * Blog article page — The Forge Log.
 *
 * Server component: statically generated for every post in
 * app/blog/posts.ts. Bodies are markdown-ish strings rendered by the
 * tiny block renderer below ("## " → h2, "- " runs → ul, blank-line
 * blocks → p). Plain React nodes only — no HTML injection.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CATEGORY_PILL, POSTS, getPost, localizePost, blogCategoryLabel } from "../posts";
import { brandTitle } from "../../../lib/brand-title";

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const contentCopy = await getLegacyTranslations("content");
  const locale = await getLocale();
  const basePost = getPost(slug);
  if (!basePost) return { title: "Braavolabs" };
  const post = localizePost(basePost, contentCopy, locale);
  return {
    title: brandTitle(`${post.title} — Braavolabs`),
    description: post.desc,
    alternates: { canonical: `https://www.braavolabs.com/blog/${slug}` },
    openGraph: {
      title: post.title,
      description: post.desc,
      type: "article",
      url: `https://www.braavolabs.com/blog/${slug}`,
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
  };
}

/** Markdown-ish block renderer: headings, bullet runs, paragraphs. */
function renderBody(body: string) {
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block, i) => {
    if (block.startsWith("## ")) {
      return (
        <h2
          key={i}
          className="bv-headline"
          style={{ fontSize: 22, marginTop: 36, marginBottom: 12, color: "var(--color-on-surface)" }}
        >
          {block.slice(3)}
        </h2>
      );
    }
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.every((l) => l.startsWith("- "))) {
      return (
        <ul key={i} style={{ margin: "0 0 18px", paddingInlineStart: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          {lines.map((l, j) => (
            <li key={j} style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "var(--color-on-surface-variant)", fontSize: 16, lineHeight: 1.75 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: "#3B82F6", marginTop: 9, flexShrink: 0, boxShadow: "0 0 8px #3B82F6", display: "inline-block" }} />
              <span>{l.slice(2)}</span>
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i} style={{ color: "var(--color-on-surface-variant)", fontSize: 16, lineHeight: 1.8, margin: "0 0 18px" }}>
        {block.replace(/\n/g, " ")}
      </p>
    );
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const uiText = await getLegacyTranslations("uiCopy");
  const { slug } = await params;
  const contentCopy = await getLegacyTranslations("content");
  const locale = await getLocale();
  const basePost = getPost(slug);
  if (!basePost) notFound();
  const post = localizePost(basePost, contentCopy, locale);

  const others = POSTS.filter((p) => p.slug !== post.slug).slice(0, 2).map(item => localizePost(item, contentCopy, locale));

  return (
    <div className="min-h-screen bv-mesh">
      {/* ── Nav ── */}
      <nav className="flex flex-wrap gap-y-2 items-center justify-between px-6 md:px-10 py-4 max-w-[1200px] mx-auto border-b border-outline-variant/40">
        <Link href="/" className="flex items-center gap-2.5" style={{ textDecoration: "none" }}>
          <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>{uiText("m809b2c4b9c83")}</div>
          <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
        </Link>
        <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6 text-sm text-on-surface-variant">
          <Link href="/blog" className="hover:text-on-surface transition-colors" style={{ textDecoration: "none", color: "inherit" }}>{uiText("m7f0fab417f12")}</Link>
          <Link href="/features" className="hover:text-on-surface transition-colors" style={{ textDecoration: "none", color: "inherit" }}>{uiText("md62a43742980")}</Link>
          <Link href="/pricing" className="hover:text-on-surface transition-colors" style={{ textDecoration: "none", color: "inherit" }}>{uiText("ma5bac859b488")}</Link>
        </div>
        <div className="flex items-center gap-2">
          <Link href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ textDecoration: "none" }}>{uiText("m2fbc11c34f42")}</Link>
          <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm" style={{ textDecoration: "none" }}>{uiText("m06d5d3008573")}</a>
        </div>
      </nav>

      {/* ── Article ── */}
      <article className="max-w-3xl mx-auto px-6 md:px-10 pt-12 pb-20">
        <Link
          href="/blog"
          className="bv-mono inline-flex items-center gap-2 mb-8"
          style={{ fontSize: 12, color: "var(--color-primary)", textDecoration: "none", letterSpacing: "0.08em" }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>arrow_back</span>{uiText("m85d560055d11")}</Link>

        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <span className={CATEGORY_PILL[post.category] ?? "bv-pill bv-pill-muted"}>{blogCategoryLabel(post.category, contentCopy)}</span>
          <span className="bv-mono" style={{ fontSize: 12, color: "#5B6473" }}>
            {post.date} · {post.read}{" "}{uiText("ma31c879fbf4a")}</span>
        </div>

        <h1
          className="bv-display"
          style={{ fontSize: "clamp(30px, 4.5vw, 44px)", lineHeight: 1.08, letterSpacing: "-0.015em", color: "var(--color-on-surface)", marginBottom: 16 }}
        >
          {post.title}
        </h1>
        <p style={{ color: "var(--color-on-surface-variant)", fontSize: 18, lineHeight: 1.7, marginBottom: 36 }}>{post.desc}</p>

        <div className="bv-divider" style={{ marginBottom: 36 }} />

        {renderBody(post.body)}

        {/* ── CTA ── */}
        <div className="bv-glass rounded-2xl px-7 py-7 mt-12 flex items-center gap-5 flex-wrap" style={{ border: "1px solid rgba(59,130,246,0.25)" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <p className="bv-title" style={{ color: "var(--color-on-surface)", marginBottom: 4 }}>{uiText("mf4e7ef98e64a")}</p>
            <p className="bv-caption" style={{ margin: 0 }}>{uiText("mb9f5c53ce5bb")}</p>
          </div>
          <Link href="https://app.braavolabs.com" className="bv-btn bv-btn-primary" style={{ textDecoration: "none" }}>{uiText("m06d5d3008573")}</Link>
        </div>

        {/* ── More posts ── */}
        {others.length > 0 && (
          <div className="mt-14">
            <h3 className="bv-mono mb-5" style={{ fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: "#5B6473" }}>{uiText("mfa5d21d1d88a")}</h3>
            <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {others.map((p) => (
                <Link key={p.slug} href={`/blog/${p.slug}`} className="bv-glass rounded-2xl px-5 py-5" style={{ textDecoration: "none" }}>
                  <span className={CATEGORY_PILL[p.category] ?? "bv-pill bv-pill-muted"}>{blogCategoryLabel(p.category, contentCopy)}</span>
                  <p className="bv-title" style={{ color: "var(--color-on-surface)", margin: "10px 0 6px", fontSize: 16 }}>{p.title}</p>
                  <p className="bv-caption line-clamp-2" style={{ margin: 0 }}>{p.desc}</p>
                </Link>
              ))}
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
