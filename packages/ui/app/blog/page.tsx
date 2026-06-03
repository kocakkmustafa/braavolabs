"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

const CATEGORIES = ["All", "Product", "Engineering", "Governance", "Field notes"] as const;
type Category = (typeof CATEGORIES)[number];

const FEATURED = {
  title: "Why we steer agents mid-run instead of re-running them",
  category: "Product",
  desc: "Re-running a failed agent wastes tokens and time. We built mid-run steering and ask_user so you redirect a run in flight — here's the architecture behind it.",
  date: "Jun 2, 2026",
  read: "7 min",
};

const POSTS = [
  {
    title: "The five risk-stops, explained",
    category: "Governance" as const,
    date: "May 28, 2026",
    read: "6 min",
    desc: "Hard, loop, cost, spam and brand — how each stop fires and why they default on.",
  },
  {
    title: "BYOK: routing 12 providers without lock-in",
    category: "Engineering" as const,
    date: "May 21, 2026",
    read: "9 min",
    desc: "The router that lets each step pick the best model — and swap it without touching your pipeline.",
  },
  {
    title: "Pocket-steering: command from your phone",
    category: "Product" as const,
    date: "May 14, 2026",
    read: "5 min",
    desc: "Authoring stays on the web; control fits in your pocket. The mobile architecture.",
  },
  {
    title: "Running fully offline with on-device Gemma",
    category: "Engineering" as const,
    date: "May 7, 2026",
    read: "8 min",
    desc: "When tokens can't leave the building — how local inference plugs into the same pipelines.",
  },
  {
    title: "What we learned shipping ask_user",
    category: "Field notes" as const,
    date: "Apr 30, 2026",
    read: "4 min",
    desc: "Agents that ask the right question at the right moment beat agents that guess.",
  },
  {
    title: "Designing an audit trail you'd actually read",
    category: "Governance" as const,
    date: "Apr 23, 2026",
    read: "7 min",
    desc: "Reasoning, tool calls and cost — every step reconstructable, none of it noise.",
  },
] satisfies { title: string; category: string; date: string; read: string; desc: string }[];

const CATEGORY_PILL: Record<string, string> = {
  Product: "bv-pill bv-pill-cyan",
  Engineering: "bv-pill bv-pill-purple",
  Governance: "bv-pill bv-pill-amber",
  "Field notes": "bv-pill bv-pill-muted",
};

export default function BlogPage() {
  const t = useTranslations();
  const [filter, setFilter] = useState<Category>("All");

  const visible = POSTS.filter(
    (p) => filter === "All" || p.category === filter
  );

  return (
    <div className="min-h-screen bv-mesh">
      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-30 flex items-center justify-between px-6 md:px-10 py-4"
        style={{
          background: "rgba(6,7,10,0.72)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--bv-gradient-brand)" }}
          >
            <span
              className="material-symbols-outlined text-white"
              style={{ fontSize: "16px" }}
            >
              bolt
            </span>
          </div>
          <span
            className="font-headline font-bold text-sm"
            style={{ color: "var(--color-on-surface)" }}
          >
            Braavolabs
          </span>
        </a>

        <div className="hidden md:flex items-center gap-6">
          {(["Features", "Pricing", "Integrations", "Changelog"] as const).map(
            (label) => (
              <a
                key={label}
                href={`/${label.toLowerCase()}`}
                className="text-sm transition-colors hover:text-white no-underline"
                style={{ color: "var(--color-on-surface-variant)" }}
              >
                {label}
              </a>
            )
          )}
          <a
            href="/blog"
            className="text-sm font-semibold no-underline"
            style={{ color: "var(--color-primary)" }}
          >
            Blog
          </a>
        </div>

        <div className="flex items-center gap-2">
          <a href="/login" className="bv-btn bv-btn-sm bv-btn-ghost no-underline">
            Sign in
          </a>
          <a href="/register" className="bv-btn bv-btn-sm bv-btn-primary no-underline">
            Start free
          </a>
        </div>
      </nav>

      {/* ── Page head ── */}
      <header className="max-w-5xl mx-auto px-6 md:px-10 pt-16 pb-10">
        <div
          className="bv-micro mb-3"
          style={{ color: "var(--color-primary)" }}
        >
          The Forge Log
        </div>
        <h1
          className="font-headline font-bold mb-3"
          style={{
            fontSize: "clamp(36px, 6vw, 64px)",
            lineHeight: 0.95,
            letterSpacing: "-0.02em",
            textTransform: "uppercase",
            color: "var(--color-on-surface)",
          }}
        >
          Notes from<br />the war-room.
        </h1>
        <p
          className="text-sm leading-relaxed"
          style={{
            color: "var(--color-on-surface-variant)",
            maxWidth: "50ch",
            fontSize: "17px",
          }}
        >
          On commanding agents — control, mobility, privacy, and the craft of
          governing autonomy.
        </p>
      </header>

      <div className="max-w-5xl mx-auto px-6 md:px-10 pb-24">
        {/* ── Featured post ── */}
        <div
          className="bv-glass grid rounded-2xl overflow-hidden mb-12 cursor-pointer"
          style={{ gridTemplateColumns: "1.2fr 1fr" }}
          role="link"
          tabIndex={0}
          aria-label={`Read featured post: ${FEATURED.title}`}
          onClick={() => {}}
          onKeyDown={(e) => e.key === "Enter" && undefined}
        >
          {/* cover */}
          <div
            className="relative flex items-center justify-center overflow-hidden"
            style={{
              minHeight: "320px",
              background:
                "linear-gradient(135deg, rgba(14,19,30,0.95), rgba(6,7,10,0.98))",
            }}
          >
            {/* stripes */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(135deg,rgba(255,255,255,0.025) 0 2px,transparent 2px 14px)",
              }}
            />
            {/* glow orb */}
            <div
              className="absolute"
              style={{
                right: "-10%",
                bottom: "-30%",
                width: "60%",
                aspectRatio: "1",
                background:
                  "radial-gradient(circle, rgba(59,130,246,0.18) 0%, transparent 70%)",
                borderRadius: "50%",
              }}
            />
            {/* category tag */}
            <span
              className="absolute top-4 left-4 bv-mono text-xs px-2 py-1 rounded-lg z-10"
              style={{
                background: "rgba(6,7,10,0.55)",
                border: "1px solid rgba(58,65,80,0.6)",
                color: "var(--color-on-surface)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              {FEATURED.category}
            </span>
            {/* large icon */}
            <span
              className="material-symbols-outlined relative z-0"
              style={{
                fontSize: "96px",
                color: "rgba(59,130,246,0.14)",
              }}
            >
              bolt
            </span>
          </div>

          {/* body */}
          <div
            className="flex flex-col justify-center p-9"
            style={{
              background: "rgba(11,13,18,0.85)",
            }}
          >
            <span
              className="bv-micro mb-3"
              style={{ color: "var(--color-primary)" }}
            >
              Featured
            </span>
            <h2
              className="font-headline font-bold mb-3"
              style={{
                fontSize: "clamp(22px, 2.6vw, 34px)",
                lineHeight: 1.05,
                letterSpacing: "-0.01em",
                textTransform: "uppercase",
                color: "var(--color-on-surface)",
              }}
            >
              {FEATURED.title}
            </h2>
            <p
              className="leading-relaxed mb-4"
              style={{
                color: "var(--color-on-surface-variant)",
                fontSize: "14px",
                maxWidth: "46ch",
              }}
            >
              {FEATURED.desc}
            </p>
            <div
              className="bv-mono text-xs flex items-center gap-1"
              style={{ color: "var(--color-outline)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
                calendar_today
              </span>
              {FEATURED.date}
              <span className="bv-divider-dot" />
              <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
                schedule
              </span>
              {FEATURED.read} read
            </div>
          </div>
        </div>

        {/* ── Category filters ── */}
        <div className="bv-fpills mb-6">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`bv-fpill${filter === cat ? " active" : ""}`}
              onClick={() => setFilter(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* ── Post grid ── */}
        <div
          className="grid gap-5 pb-6"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          }}
        >
          {visible.map((post) => (
            <article
              key={post.title}
              className="bv-glass flex flex-col overflow-hidden cursor-pointer group"
              role="link"
              tabIndex={0}
              aria-label={`Read post: ${post.title}`}
              onClick={() => {}}
              onKeyDown={(e) => e.key === "Enter" && undefined}
            >
              {/* cover thumbnail */}
              <div
                className="relative overflow-hidden flex items-center justify-center"
                style={{
                  height: "160px",
                  background:
                    "linear-gradient(135deg, rgba(14,19,30,0.95), rgba(6,7,10,0.98))",
                }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(135deg,rgba(255,255,255,0.02) 0 2px,transparent 2px 14px)",
                  }}
                />
                <div
                  className="absolute"
                  style={{
                    right: "-15%",
                    bottom: "-30%",
                    width: "55%",
                    aspectRatio: "1",
                    background:
                      "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)",
                    borderRadius: "50%",
                  }}
                />
                <span
                  className="absolute top-3 left-3 z-10"
                  style={{}}
                >
                  <span className={CATEGORY_PILL[post.category] ?? "bv-pill bv-pill-muted"}>
                    {post.category}
                  </span>
                </span>
                <span
                  className="material-symbols-outlined relative z-0"
                  style={{
                    fontSize: "64px",
                    color: "rgba(59,130,246,0.10)",
                  }}
                >
                  article
                </span>
              </div>

              {/* body */}
              <div className="flex flex-col flex-1 p-5">
                <h3
                  className="font-headline font-bold mb-2 group-hover:text-primary transition-colors"
                  style={{
                    fontSize: "17px",
                    lineHeight: 1.15,
                    letterSpacing: "-0.005em",
                    color: "var(--color-on-surface)",
                  }}
                >
                  {post.title}
                </h3>
                <p
                  className="flex-1 leading-relaxed mb-4"
                  style={{
                    color: "var(--color-on-surface-variant)",
                    fontSize: "13px",
                    lineHeight: 1.55,
                  }}
                >
                  {post.desc}
                </p>
                <div
                  className="bv-mono text-xs flex items-center gap-1"
                  style={{ color: "var(--color-outline)" }}
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: "13px" }}
                  >
                    calendar_today
                  </span>
                  {post.date}
                  <span className="bv-divider-dot" />
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: "13px" }}
                  >
                    schedule
                  </span>
                  {post.read} read
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      {/* ── Footer ── */}
      <footer
        className="border-t"
        style={{ borderColor: "rgba(58,65,80,0.18)" }}
      >
        <div className="max-w-5xl mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {/* brand */}
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2 mb-3 no-underline">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--bv-gradient-brand)" }}
                >
                  <span
                    className="material-symbols-outlined text-white"
                    style={{ fontSize: "14px" }}
                  >
                    bolt
                  </span>
                </div>
                <span
                  className="font-headline font-bold text-sm"
                  style={{ color: "var(--color-on-surface)" }}
                >
                  Braavolabs
                </span>
              </a>
              <p
                className="text-xs leading-relaxed"
                style={{ color: "var(--color-on-surface-variant)", maxWidth: "22ch" }}
              >
                Command the AI agents &amp; automations you already run.
              </p>
            </div>

            {/* Product */}
            <div>
              <h5
                className="bv-micro mb-3"
                style={{ color: "var(--color-outline)" }}
              >
                Product
              </h5>
              {["Features", "Pricing", "Integrations", "Changelog"].map(
                (link) => (
                  <a
                    key={link}
                    href={`/${link.toLowerCase()}`}
                    className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                    style={{ color: "var(--color-on-surface-variant)" }}
                  >
                    {link}
                  </a>
                )
              )}
            </div>

            {/* Company */}
            <div>
              <h5
                className="bv-micro mb-3"
                style={{ color: "var(--color-outline)" }}
              >
                Company
              </h5>
              {["About", "Blog", "Contact", "Status"].map((link) => (
                <a
                  key={link}
                  href={link === "Blog" ? "/blog" : `/${link.toLowerCase()}`}
                  className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                  style={{
                    color:
                      link === "Blog"
                        ? "var(--color-primary)"
                        : "var(--color-on-surface-variant)",
                  }}
                >
                  {link}
                </a>
              ))}
            </div>

            {/* Legal */}
            <div>
              <h5
                className="bv-micro mb-3"
                style={{ color: "var(--color-outline)" }}
              >
                Legal
              </h5>
              {["Privacy", "Terms", "KVKK", "GDPR"].map((link) => (
                <a
                  key={link}
                  href="#"
                  className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                  style={{ color: "var(--color-on-surface-variant)" }}
                >
                  {link}
                </a>
              ))}
            </div>
          </div>

          <div className="bv-divider my-8" />

          <p
            className="bv-mono text-center"
            style={{ color: "var(--color-outline)", fontSize: "11px" }}
          >
            © 2026 Braavolabs. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
