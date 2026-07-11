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
import { CATEGORY_PILL, POSTS, getPost } from "../posts";

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: "Post not found — Braavolabs" };
  return {
    title: `${post.title} — Braavolabs`,
    description: post.desc,
    alternates: { canonical: `https://braavolabs.com/blog/${slug}` },
    openGraph: {
      title: post.title,
      description: post.desc,
      type: "article",
      url: `https://braavolabs.com/blog/${slug}`,
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
          style={{ fontSize: 22, marginTop: 36, marginBottom: 12, color: "#E8EBF0" }}
        >
          {block.slice(3)}
        </h2>
      );
    }
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.every((l) => l.startsWith("- "))) {
      return (
        <ul key={i} style={{ margin: "0 0 18px", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          {lines.map((l, j) => (
            <li key={j} style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "#9AA3B2", fontSize: 16, lineHeight: 1.75 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: "#3B82F6", marginTop: 9, flexShrink: 0, boxShadow: "0 0 8px #3B82F6", display: "inline-block" }} />
              <span>{l.slice(2)}</span>
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p key={i} style={{ color: "#9AA3B2", fontSize: 16, lineHeight: 1.8, margin: "0 0 18px" }}>
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
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const others = POSTS.filter((p) => p.slug !== post.slug).slice(0, 2);

  return (
    <div className="min-h-screen bv-mesh">
      {/* ── Nav ── */}
      <nav className="flex items-center justify-between px-6 md:px-10 py-4 max-w-[1200px] mx-auto border-b border-outline-variant/40">
        <Link href="/" className="flex items-center gap-2.5" style={{ textDecoration: "none" }}>
          <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>
            BL
          </div>
          <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
        </Link>
        <div className="hidden md:flex items-center gap-6 text-sm text-on-surface-variant">
          <Link href="/blog" className="hover:text-on-surface transition-colors" style={{ textDecoration: "none", color: "inherit" }}>Blog</Link>
          <Link href="/features" className="hover:text-on-surface transition-colors" style={{ textDecoration: "none", color: "inherit" }}>Features</Link>
          <Link href="/pricing" className="hover:text-on-surface transition-colors" style={{ textDecoration: "none", color: "inherit" }}>Pricing</Link>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login" className="bv-btn bv-btn-ghost bv-btn-sm" style={{ textDecoration: "none" }}>Sign in</Link>
          <Link href="/register" className="bv-btn bv-btn-primary bv-btn-sm" style={{ textDecoration: "none" }}>Start free</Link>
        </div>
      </nav>

      {/* ── Article ── */}
      <article className="max-w-3xl mx-auto px-6 md:px-10 pt-12 pb-20">
        <Link
          href="/blog"
          className="bv-mono inline-flex items-center gap-2 mb-8"
          style={{ fontSize: 12, color: "#60A5FA", textDecoration: "none", letterSpacing: "0.08em" }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>arrow_back</span>
          The Forge Log
        </Link>

        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <span className={CATEGORY_PILL[post.category] ?? "bv-pill bv-pill-muted"}>{post.category}</span>
          <span className="bv-mono" style={{ fontSize: 12, color: "#5B6473" }}>
            {post.date} · {post.read} read
          </span>
        </div>

        <h1
          className="bv-display"
          style={{ fontSize: "clamp(30px, 4.5vw, 44px)", lineHeight: 1.08, letterSpacing: "-0.015em", color: "#E8EBF0", marginBottom: 16 }}
        >
          {post.title}
        </h1>
        <p style={{ color: "#9AA3B2", fontSize: 18, lineHeight: 1.7, marginBottom: 36 }}>{post.desc}</p>

        <div className="bv-divider" style={{ marginBottom: 36 }} />

        {renderBody(post.body)}

        {/* ── CTA ── */}
        <div className="bv-glass rounded-2xl px-7 py-7 mt-12 flex items-center gap-5 flex-wrap" style={{ border: "1px solid rgba(59,130,246,0.25)" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <p className="bv-title" style={{ color: "#E8EBF0", marginBottom: 4 }}>Command the agents you already run.</p>
            <p className="bv-caption" style={{ margin: 0 }}>Start free — no card needed. Bring your own keys across 14 providers.</p>
          </div>
          <Link href="/register" className="bv-btn bv-btn-primary" style={{ textDecoration: "none" }}>
            Start free
          </Link>
        </div>

        {/* ── More posts ── */}
        {others.length > 0 && (
          <div className="mt-14">
            <h3 className="bv-mono mb-5" style={{ fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: "#5B6473" }}>
              More from the Forge Log
            </h3>
            <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {others.map((p) => (
                <Link key={p.slug} href={`/blog/${p.slug}`} className="bv-glass rounded-2xl px-5 py-5" style={{ textDecoration: "none" }}>
                  <span className={CATEGORY_PILL[p.category] ?? "bv-pill bv-pill-muted"}>{p.category}</span>
                  <p className="bv-title" style={{ color: "#E8EBF0", margin: "10px 0 6px", fontSize: 16 }}>{p.title}</p>
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
