"use client";
import LegalOperator from "../../components/LegalOperator";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

const SECTION_IDS = ["veri-sorumlusu","islenen-kisisel-veriler","isleme-amaclari","hukuki-sebepler","ucuncu-taraf-aktarimlari","saklama-suresi","haklariniz","basvuru"] as const;

const DOC_LINKS = [
  { href: "/privacy", labelKey: "privacy" },
  { href: "/terms", labelKey: "terms" },
  { href: "/cookies", labelKey: "cookies" },
  { href: "/gdpr", label: "GDPR" },
  { href: "/kvkk", label: "KVKK", active: true },
  { href: "/legal/account-deletion", labelKey: "accountDeletion" },
];

export default function KvkkPage() {
  const copy = useLegacyTranslations("surface");
  const SECTIONS = SECTION_IDS.map(id => ({ id, title: copy(`legal.kvkk.${id}.title`), body: copy(`legal.kvkk.${id}.body`) }));
  const uiText = useLegacyTranslations("uiCopy");
  // Every visitor sees the translated preview notice. Legal completion remains open.
  const t = useTranslations();
  const locale = useLocale();
  const showBanner = true;

  return (
    <div className="min-h-screen bg-background mesh-bg">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-40 glass-panel">
        <div className="max-w-[1100px] mx-auto flex flex-wrap gap-y-2 items-center justify-between px-6 md:px-10 min-h-14 py-2 md:py-0">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="bv-avatar" style={{ width: 32, height: 32, fontSize: 12 }}>
              B
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </Link>
          <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6 text-sm text-on-surface-variant">
            <Link href="/#features" className="hover:text-on-surface transition-colors">{uiText("m760104947f15")}</Link>
            <Link href="/pricing" className="hover:text-on-surface transition-colors">{uiText("m69d527a460e7")}</Link>
            <Link href="/about" className="hover:text-on-surface transition-colors">{uiText("mb2399da1a08c")}</Link>
          </div>
          <div className="flex items-center gap-2">
            <Link href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm">{uiText("me140e826ba9c")}</Link>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm bv-legal-cta">{t("static.common.legalNavigation.openApp")}</a>
          </div>
        </div>
      </nav>

      {/* ── Page head ───────────────────────────────────────── */}
      <header className="relative pt-14 pb-2 text-center overflow-hidden">
        {/* Watermark logo */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 w-64 aspect-square opacity-[0.03]"
          style={{
            background: "radial-gradient(circle, var(--bv-cobalt-glow) 60%, transparent 74%)",
          }}
        />
        <div className="relative max-w-[1100px] mx-auto px-6">
          {/* Eyebrow */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-micro">{t("static.common.legalNavigation.legal")}</span>
          </div>
          <h1 className="bv-display text-on-surface" style={{ fontSize: "clamp(2rem, 5vw, 3.75rem)", textTransform: "uppercase", letterSpacing: "-0.02em" }}>
            KVKK
          </h1>
          <p className="bv-mono text-on-surface-variant mt-3">{t("static.common.lastUpdated")}{" "}{new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "long" }).format(new Date("2026-10-20T00:00:00Z"))}</p>

          {/* Doc switcher pills */}
          <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
            {DOC_LINKS.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                className={`bv-fpill${d.active ? " active" : ""}`}
              >
                {d.labelKey ? t(`static.common.legalNavigation.${d.labelKey}`) : d.label}
              </Link>
            ))}
          </div>
        </div>
      </header>

      {/* ── Article grid: TOC + prose ───────────────────────── */}
      <main id="main-content" tabIndex={-1} className="max-w-[1040px] mx-auto px-6 md:px-8 mt-10 pb-28 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-12">
        {/* TOC — hidden on mobile */}
        <aside className="hidden md:block">
          <nav className="sticky top-20 space-y-0.5">
            <p className="bv-micro mb-3">{t("static.common.legalNavigation.onThisPage")}</p>
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="block text-sm text-on-surface-variant hover:text-on-surface transition-colors py-1.5 pl-3 border-l border-outline-variant hover:border-primary"
                style={{ lineHeight: 1.3 }}
              >
                {s.title}
              </a>
            ))}
          </nav>
        </aside>

        {/* Prose */}
        <article className="max-w-[72ch] bv-stagger">
          {/* Localisation banner */}
          {showBanner && (
            <div className="bv-glass mb-8 px-4 py-3 text-xs text-on-surface-variant rounded-xl">
              <span className="material-symbols-outlined text-primary mr-2" style={{ fontSize: 16, verticalAlign: "middle" }}>
                language
              </span>
              {copy("legal.previewNotice")}
            </div>
          )}

          <div className="bv-divider mb-8" />

          {SECTIONS.map((section) => (
            <section key={section.id} className="mb-9">
              <h2
                id={section.id}
                className="flex items-center gap-2 bv-headline text-on-surface mb-3"
                style={{
                  fontSize: "1.25rem",
                  textTransform: "uppercase",
                  letterSpacing: "-0.01em",
                  scrollMarginTop: "5.5rem",
                }}
              >
                {section.title}
                <a
                  href={`#${section.id}`}
                  className="opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity text-primary text-sm font-normal"
                  aria-label={t("static.common.legalNavigation.permalinkTo", { title: section.title })}
                >
                  ¶
                </a>
              </h2>
              <p className="text-on-surface-variant leading-relaxed" style={{ fontSize: "0.97rem", lineHeight: 1.8 }}>
                {section.body}
              </p>
              {section.id === "veri-sorumlusu" && <LegalOperator />}
              <div className="bv-divider mt-8" />
            </section>
          ))}

          {/* Contact CTA */}
          <div className="bv-glass p-6 rounded-2xl mt-4">
            <div className="flex items-start gap-4">
              <span className="material-symbols-outlined text-primary mt-0.5" style={{ fontSize: 22 }}>
                mail
              </span>
              <div>
                <p className="bv-title mb-1">{uiText("m471494a678dc")}</p>
                <p className="bv-caption">{uiText("md16b7b8e76f6")}{" "}
                  <a
                    href="mailto:kvkk@braavolabs.com"
                    className="text-primary hover:underline transition-colors"
                  >
                    kvkk@braavolabs.com
                  </a>{" "}{uiText("md2e44bfde665")}</p>
              </div>
            </div>
          </div>
        </article>
      </main>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="bv-divider" />
      <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-10 grid grid-cols-2 md:grid-cols-4 gap-8">
        <div className="col-span-2 md:col-span-1">
          <Link href="/" className="flex items-center gap-2.5 mb-3">
            <div className="bv-avatar" style={{ width: 28, height: 28, fontSize: 11 }}>B</div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </Link>
          <p className="bv-caption">{uiText("m8c04ee5bf3f2")}</p>
        </div>
        <div>
          <p className="bv-micro mb-3">{uiText("ma0eb87bbeb56")}</p>
          <div className="space-y-2 text-sm text-on-surface-variant">
            <Link href="/#features" className="block hover:text-on-surface transition-colors">{uiText("m760104947f15")}</Link>
            <Link href="/pricing" className="block hover:text-on-surface transition-colors">{uiText("m69d527a460e7")}</Link>
            <Link href="/changelog" className="block hover:text-on-surface transition-colors">{uiText("mc051ae69c4ff")}</Link>
          </div>
        </div>
        <div>
          <p className="bv-micro mb-3">{uiText("m3977aafcc314")}</p>
          <div className="space-y-2 text-sm text-on-surface-variant">
            <Link href="/about" className="block hover:text-on-surface transition-colors">{uiText("mb2399da1a08c")}</Link>
            <Link href="/blog" className="block hover:text-on-surface transition-colors">{uiText("mf519587a824a")}</Link>
            <Link href="/contact" className="block hover:text-on-surface transition-colors">{uiText("m46ce898e63fc")}</Link>
          </div>
        </div>
        <div>
          <p className="bv-micro mb-3">{t("static.common.legalNavigation.legal")}</p>
          <div className="space-y-2 text-sm text-on-surface-variant">
            <Link href="/privacy" className="block hover:text-on-surface transition-colors">{t("static.common.legalNavigation.privacy")}</Link>
            <Link href="/terms" className="block hover:text-on-surface transition-colors">{t("static.common.legalNavigation.terms")}</Link>
            <Link href="/kvkk" className="block text-primary">KVKK</Link>
            <Link href="/gdpr" className="block hover:text-on-surface transition-colors">GDPR</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
