"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { useTranslations } from "next-intl";

// Changelog entries — mirrors the LOG array in changelog.html reference mock
const LOG: Array<{
  v: string;
  date: string;
  latest?: boolean;
  items: Array<[string, string]>;
}> = [
  {
    v: "v1.8",
    date: "Jun 1, 2026",
    latest: true,
    items: [
      ["added", "Local-route boundaries documented without claiming an offline product bundle"],
      ["added", "Evidence export preview documented for development testing"],
      ["changed", "Run detail now streams reasoning tokens live as they generate"],
    ],
  },
  {
    v: "v1.7",
    date: "May 18, 2026",
    items: [
      ["added", "Mid-run steering composer — inject guidance into the next turn"],
      ["added", "ask_user resume loop on web and mobile"],
      ["fixed", "Cost-stop now triggers before the gating step, not after"],
    ],
  },
  {
    v: "v1.6",
    date: "May 4, 2026",
    items: [
      ["added", "Connect & monitor n8n, Make and Zapier on a unified timeline"],
      ["changed", "Visual builder gained parallel-aware concurrent lanes"],
      ["fixed", "Pipeline minimap drift on high-DPI displays"],
    ],
  },
  {
    v: "v1.5",
    date: "Apr 20, 2026",
    items: [
      ["added", "BYOK and local-route selection documented without a fixed provider-count claim"],
      ["added", "Brand-stop risk-stop for tone & brand-rule violations"],
      ["fixed", "Mobile pocket-steer push deep-links open straight to the run"],
    ],
  },
];

// Map kind → bv-pill variant class + icon
const KIND_STYLES: Record<string, { pill: string; icon: string }> = {
  added:   { pill: "bv-pill bv-pill-cyan",   icon: "add_circle" },
  fixed:   { pill: "bv-pill bv-pill-purple",  icon: "build_circle" },
  changed: { pill: "bv-pill bv-pill-amber",   icon: "change_circle" },
};

export default function ChangelogPage() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  // t.raw returns the unprocessed JSON value — required for arrays so we
  // can map over the items list without resorting to indexed key lookups.
  const _items = t.raw("static.changelog.items") as string[];

  return (
    <div className="bv-mesh min-h-screen">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-40 glass-panel border-b border-outline-variant/30">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 flex flex-wrap gap-y-2 items-center justify-between min-h-14 py-2 md:py-0">
          {/* Lockup */}
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center bv-btn-primary flex-shrink-0">
              <span className="text-white font-bold text-[10px] font-headline">{uiText("m73b582c8d1ab")}</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>

          {/* Nav links (hidden on small screens) */}
          <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6 text-sm text-on-surface-variant">
            <a href="/features" className="hover:text-on-surface transition-colors">{uiText("maf32376bdf35")}</a>
            <a href="/pricing" className="hover:text-on-surface transition-colors">{uiText("m89ea286c8147")}</a>
            <a href="/#providers" className="hover:text-on-surface transition-colors">{uiText("mdcad451eaa8b")}</a>
            <a href="/changelog" className="text-primary font-semibold">{uiText("m000db379830b")}</a>
            <a href="/blog" className="hover:text-on-surface transition-colors">{uiText("mf6a8a22d3745")}</a>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm hidden sm:inline-flex">
              {t("static.common.back")}
            </a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm bv-sheen">{uiText("mf0c7cea418fa")}</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="text-center pt-16 pb-10 px-6">
        <div className="bv-pill bv-pill-cyan inline-flex mx-auto mb-4">
          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>history</span>{uiText("m000db379830b")}</div>
        <h1 className="bv-display text-on-surface" style={{ fontSize: "clamp(38px,6vw,64px)", letterSpacing: "-0.02em" }}>{uiText("mc233f3d5475f")}<br />
          <span className="bv-grad-text">{uiText("m201fb23bec45")}</span>
        </h1>
        <p className="text-on-surface-variant mt-4 text-base max-w-sm mx-auto">{uiText("m7af9fcb2eb00")}</p>
      </header>

      {/* ── Timeline ── */}
      <div className="max-w-[760px] mx-auto px-6 pb-24">
        {/* Arc filament spine */}
        <div className="relative">
          {/* Vertical gradient spine line */}
          <div
            className="absolute left-[7px] top-2 bottom-16 w-0.5 pointer-events-none"
            style={{
              background: "linear-gradient(180deg, #60A5FA 0%, rgba(59,130,246,0.12) 100%)",
              boxShadow: "0 0 10px rgba(59,130,246,0.35)",
            }}
          />

          <div className="bv-stagger">
            {LOG.map((entry) => (
              <div key={entry.v} className="relative pl-11 pb-9">
                {/* Version node */}
                <div
                  className="absolute left-0 top-1.5 w-4 h-4 rounded-full z-10 flex items-center justify-center"
                  style={{
                    background: "var(--color-background)",
                    border: "2px solid #60A5FA",
                    boxShadow: entry.latest
                      ? "0 0 16px rgba(59,130,246,0.7), 0 0 32px rgba(59,130,246,0.3)"
                      : "0 0 8px rgba(59,130,246,0.3)",
                  }}
                >
                  {entry.latest && (
                    /* Ping ring on latest node */
                    <span
                      className="absolute inset-[-5px] rounded-full pointer-events-none"
                      style={{
                        border: "1px solid rgba(96,165,250,0.5)",
                        animation: "cl-ping 1.8s cubic-bezier(0.4,0,0.2,1) infinite",
                      }}
                    />
                  )}
                </div>

                {/* Version header */}
                <div className="flex items-center gap-3 mb-3">
                  <span
                    className="font-headline font-semibold text-on-surface"
                    style={{ fontSize: 22, letterSpacing: "-0.01em" }}
                  >
                    {entry.v}
                  </span>
                  {entry.latest && (
                    <span className="bv-pill bv-pill-cyan">{uiText("mb029bf94b9cb")}</span>
                  )}
                  <time
                    className="ml-auto bv-mono text-outline"
                    style={{ fontSize: 12 }}
                  >
                    {entry.date}
                  </time>
                </div>

                {/* Changelog card */}
                <div className="bv-glass rounded-2xl overflow-hidden">
                  <div className="divide-y divide-outline-variant/30">
                    {entry.items.map(([kind, text], i) => {
                      const style = KIND_STYLES[kind] ?? KIND_STYLES["added"];
                      return (
                        <div
                          key={i}
                          className="flex items-start gap-3 px-5 py-3.5"
                        >
                          <span className={`${style.pill} flex-shrink-0 mt-0.5`}>
                            <span className="material-symbols-outlined" style={{ fontSize: 10 }}>
                              {style.icon}
                            </span>
                            {kind}
                          </span>
                          <span className="text-on-surface text-sm leading-relaxed">
                            {text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* GitHub releases link */}
        <p className="text-center text-on-surface-variant text-sm pt-4">
          {t("static.changelog.githubIntro")}{" "}
          <a
            href="https://github.com/kocakkmustafa/braavolabs/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary-fixed transition-colors inline-flex items-center gap-1"
          >{"github.com/kocakkmustafa/braavolabs/releases"}<span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
          </a>
        </p>
      </div>

      {/* Ping keyframe injected inline (no extra CSS file needed) */}
      <style>{`
        @keyframes cl-ping {
          0%   { transform: scale(0.6); opacity: 0.9; }
          100% { transform: scale(1.9); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
