"use client";

import { useTranslations } from "next-intl";

export default function AboutPage() {
  const t = useTranslations();

  const principles = [
    {
      n: "01",
      title: t("static.about.section1Title"),
      body: t("static.about.section1Body"),
    },
    {
      n: "02",
      title: t("static.about.section2Title"),
      body: t("static.about.section2Body"),
    },
    {
      n: "03",
      title: t("static.about.section3Title"),
      body: t("static.about.section3Body"),
    },
  ];

  return (
    <div className="min-h-screen bg-background bv-mesh">
      {/* ── Minimal top nav ── */}
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 h-14 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg bv-btn-primary flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-xs font-headline">B</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>
          <a
            href="/"
            className="bv-btn bv-btn-ghost bv-btn-sm flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>arrow_back</span>
            {t("static.common.back")}
          </a>
        </div>
      </nav>

      <main>
        {/* ── Hero / Manifesto ── */}
        <header className="pt-24 pb-4 text-center px-6">
          <div className="max-w-[1100px] mx-auto">
            <div className="inline-flex items-center gap-2 mb-8 px-3 py-1.5 rounded-full border border-outline-variant bg-surface-container">
              <span className="bv-dot bv-dot bv-running bv-ping" />
              <span className="bv-micro text-primary">{t("static.about.subtitle")}</span>
            </div>
            <div className="space-y-1 select-none" aria-label="Manifesto">
              <p className="font-headline font-semibold uppercase tracking-tight text-on-surface/30 leading-none"
                style={{ fontSize: "clamp(34px,6.5vw,82px)", letterSpacing: "-0.02em", lineHeight: 0.96 }}>
                Anyone can
              </p>
              <p className="font-headline font-semibold uppercase tracking-tight text-on-surface/30 leading-none"
                style={{ fontSize: "clamp(34px,6.5vw,82px)", letterSpacing: "-0.02em", lineHeight: 0.96 }}>
                build an agent.
              </p>
              <p className="font-headline font-semibold uppercase tracking-tight leading-none"
                style={{ fontSize: "clamp(34px,6.5vw,82px)", letterSpacing: "-0.02em", lineHeight: 0.96 }}>
                <span className="bv-grad-text">Few can command one.</span>
              </p>
            </div>
          </div>
        </header>

        {/* ── Emblem story ── */}
        <section className="max-w-[1100px] mx-auto px-6 md:px-10 py-20">
          <div className="grid md:grid-cols-[0.9fr_1.1fr] gap-14 items-center">
            {/* emblem */}
            <div className="relative aspect-square max-w-[340px] mx-auto w-full reveal">
              <div
                className="absolute inset-[-12%] rounded-full animate-pulse-glow pointer-events-none"
                style={{
                  background: "radial-gradient(circle, rgba(59,130,246,.28), transparent 65%)",
                  filter: "blur(14px)",
                }}
              />
              <div
                className="relative z-10 w-full h-full rounded-full flex items-center justify-center border border-outline-variant bg-surface-container glow-cyan"
                style={{ maskImage: "radial-gradient(circle,#000 70%,transparent 80%)", WebkitMaskImage: "radial-gradient(circle,#000 70%,transparent 80%)" }}
              >
                <div
                  className="w-3/4 h-3/4 rounded-2xl bv-btn-primary flex items-center justify-center bv-sheen"
                  style={{ background: "var(--bv-gradient-brand)" }}
                >
                  <span className="font-headline font-bold text-white" style={{ fontSize: "clamp(36px,8vw,72px)", letterSpacing: "-0.03em" }}>B</span>
                </div>
              </div>
            </div>

            {/* copy */}
            <div className="reveal">
              <div className="bv-micro text-primary mb-4">The emblem</div>
              <h2
                className="font-headline font-semibold uppercase text-on-surface mb-5"
                style={{ fontSize: "clamp(22px,2.8vw,36px)", letterSpacing: "-0.01em", lineHeight: 1.05 }}
              >
                The faceless operator
              </h2>
              <p className="text-on-surface-variant text-sm leading-relaxed mb-4 max-w-[52ch]">
                Our emblem is a forged iron mask — a nod to Braavos, where the most capable operators work unseen.
                It stands for the way real work gets done with AI: not by the loudest demo, but by the operator
                who quietly <span className="text-on-surface font-medium">reads, approves and steers</span> a team of agents to a result.
              </p>
              <p className="text-on-surface-variant text-sm leading-relaxed max-w-[52ch]">
                Everything we build has weight, glint and motion — because commanding agents should feel like
                standing in a war-room, not babysitting a chatbot.
              </p>
            </div>
          </div>
        </section>

        {/* ── Moat line ── */}
        <section className="py-20 text-center px-6 border-y border-outline-variant bg-surface-container-low/50">
          <div className="max-w-[1100px] mx-auto">
            <div className="bv-micro text-primary mb-5">The moat, in one line</div>
            <h2
              className="font-headline font-medium uppercase text-on-surface-variant mx-auto"
              style={{ fontSize: "clamp(20px,3vw,40px)", letterSpacing: "-0.01em", lineHeight: 1.1, maxWidth: "24ch" }}
            >
              We compete on{" "}
              <span className="text-on-surface font-semibold">control</span>,{" "}
              <span className="text-on-surface font-semibold">mobility</span> and{" "}
              <span className="text-on-surface font-semibold">privacy</span>{" "}
              — never on connector count.
            </h2>
          </div>
        </section>

        {/* ── Principles ── */}
        <section className="max-w-[1100px] mx-auto px-6 md:px-10 py-20">
          <div className="bv-micro text-primary mb-6 reveal">Principles</div>
          <div className="grid md:grid-cols-3 gap-4 bv-stagger">
            {principles.map((p) => (
              <div key={p.n} className="bv-glass p-7 reveal">
                <span className="bv-mono text-primary tracking-widest">{p.n}</span>
                <h3
                  className="font-headline font-semibold uppercase text-on-surface mt-3.5 mb-2.5"
                  style={{ fontSize: "18px", letterSpacing: "-0.005em" }}
                >
                  {p.title}
                </h3>
                <p className="text-on-surface-variant text-sm leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Founder note ── */}
        <section className="py-20 px-6">
          <div className="max-w-[1100px] mx-auto">
            <div className="bv-glass max-w-[720px] mx-auto p-10 text-center reveal glow-cyan">
              <blockquote
                className="font-headline font-medium text-on-surface leading-snug mb-6"
                style={{ fontSize: "clamp(18px,2.2vw,26px)", letterSpacing: "-0.01em" }}
              >
                &ldquo;We built Braavolabs because we were tired of agents that could act but couldn&rsquo;t be governed.
                Power without a hand on the tiller isn&rsquo;t useful &mdash; it&rsquo;s a liability.&rdquo;
              </blockquote>
              <div className="bv-mono text-on-surface-variant">
                &mdash; <span className="text-on-surface font-medium">The Braavolabs team</span> &middot; forged in the open
              </div>
            </div>
          </div>
        </section>

        {/* ── CTA / Acta ── */}
        <section className="py-24 text-center px-6 pb-28">
          <div className="max-w-[1100px] mx-auto">
            <h2
              className="font-headline font-semibold uppercase text-on-surface mb-8"
              style={{ fontSize: "clamp(26px,4vw,52px)", letterSpacing: "-0.02em" }}
            >
              {t("static.about.title")}
            </h2>
            <div className="flex gap-3.5 justify-center flex-wrap">
              <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-sheen">
                <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>rocket_launch</span>
                Open app
              </a>
              <a href="/contact" className="bv-btn bv-btn-ghost">
                Talk to us
              </a>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
