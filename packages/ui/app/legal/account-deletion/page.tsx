"use client";
import LegalOperator from "../../../components/LegalOperator";
import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


/**
 * Public account-deletion landing page.
 *
 * Required by:
 * - Google Play Data Safety (Feb 2024): apps that allow account creation
 *   must provide a publicly accessible URL where users can request
 *   account + data deletion without needing to install the app.
 * This page documents the deletion-request channel that is currently
 * evidenced and publicly reachable. It does not claim an in-app workflow.
 *
 * Linked from the marketing footer and listed in sitemap.ts.
 */

import { useLocale, useTranslations } from "next-intl";



export default function AccountDeletionPage() {
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  const sections = [
    {
      id: "overview",
      title: runtimeCopy("m0d18e6731423"),
      icon: "info",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("med3b20e61c41")}</p>
        </>
      ),
    },
    {
      id: "option-1",
      title: runtimeCopy("m99c2fc0bb65c"),
      icon: "mail",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("m1b2db4796a78")}{" "}
            <a
              href="mailto:privacy@braavolabs.com?subject=Account%20deletion%20request"
              className="text-primary underline hover:text-primary-fixed transition-colors"
            >
              privacy@braavolabs.com
            </a>{" "}{uiText("m442ce29a97e5")}{" "}<em>{uiText("m3142da1ab41a")}</em>{uiText("mc804e0a279e5")}</p>
        </>
      ),
    },
    {
      id: "option-2",
      title: runtimeCopy("md2fa5c7e5df0"),
      icon: "verified_user",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("m38ad53145e92")}</p>
        </>
      ),
    },
    {
      id: "option-3",
      title: runtimeCopy("me4c98c0271e8"),
      icon: "info",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("m29f4515a2181")}</p>
        </>
      ),
    },
    {
      id: "what-gets-deleted",
      title: runtimeCopy("m000165a9f23d"),
      icon: "delete_forever",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("mee9120dd9911")}</p>
          <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
            <li>{uiText("m0a13dcea737c")}</li>
            <li>{uiText("m3dd748c0c124")}</li>
            <li>{uiText("m67b7fbf8d86d")}</li>
          </ul>
        </>
      ),
    },
    {
      id: "what-we-retain",
      title: runtimeCopy("m4178821e2ee3"),
      icon: "archive",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("m292e9193635f")}</p>
          <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
            <li>{uiText("m3acb87ce044a")}</li>
            <li>{uiText("m9956d26e8534")}</li>
            <li>{uiText("m665793086a11")}</li>
          </ul>
        </>
      ),
    },
    {
      id: "timeline",
      title: runtimeCopy("m21ce09941e6e"),
      icon: "schedule",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("m764489556bb6")}</p>
        </>
      ),
    },
    {
      id: "active-subscriptions",
      title: runtimeCopy("mc5d1045cc31b"),
      icon: "subscriptions",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("mc3704343f072")}{" "}
            <a
              href="mailto:support@yulalab.com"
              className="text-primary underline hover:text-primary-fixed transition-colors"
            >
              support@yulalab.com
            </a>{" "}{uiText("m262a258637ac")}</p>
        </>
      ),
    },
    {
      id: "questions",
      title: runtimeCopy("md772994860a6"),
      icon: "help",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("mb2c239031d04")}{" "}
            <a
              href="mailto:privacy@braavolabs.com"
              className="text-primary underline hover:text-primary-fixed transition-colors"
            >
              privacy@braavolabs.com
            </a>{uiText("mcf0d0c778c1f")}{" "}
            <a href="/gdpr" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m29492eb1f9b7")}</a>{" "}{uiText("m79a0490687e1")}{" "}
            <a href="/kvkk" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("mf75327b3ab03")}</a>
            .
          </p>
          <LegalOperator />
        </>
      ),
    },
  ];

  const t = useTranslations();
  const legal = useTranslations("static.common.legalNavigation");
  const page = useTranslations("static.common.legalPage");
  const locale = useLocale();
  // The deletion notice is localized; mark the document's language and direction to match.
  const documentDir = locale === "ar" ? "rtl" : "ltr";
  const updatedMonth = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date("2026-05-01T00:00:00Z"));

  return (
    <div className="min-h-screen bg-background bv-mesh [--bv-legal-offset:140px] lg:[--bv-legal-offset:90px]">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1100px] mx-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 md:gap-3 px-6 md:px-10 min-h-14 py-2 md:py-3">
          <a href="/" aria-label="Braavolabs" className="flex shrink-0 items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bv-btn-primary bv-btn">
              <span className="text-white font-bold text-xs leading-none">AI</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface max-sm:hidden">Braavolabs</span>
          </a>
          <div className="flex order-last w-full md:order-3 lg:order-none md:w-full lg:w-auto flex-wrap items-center justify-center gap-x-6 gap-y-1 md:gap-y-2">
            <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors max-md:inline-flex max-md:items-center max-md:min-h-8">{t("nav.features")}</a>
            <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors max-md:inline-flex max-md:items-center max-md:min-h-8">{t("nav.pricing")}</a>
            <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors max-md:inline-flex max-md:items-center max-md:min-h-8">{page("about")}</a>
          </div>
          <div className="ms-auto flex flex-wrap items-center justify-end gap-3">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm">{t("nav.signIn")}</a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm text-sm bv-legal-cta">{legal("openApp")}</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center pt-[clamp(56px,8vw,90px)] pb-10 overflow-hidden">
        {/* Watermark logo */}
        <div
          className="pointer-events-none absolute left-1/2 top-[10%] -translate-x-1/2 w-[280px] aspect-square opacity-[0.04]"
          style={{ WebkitMaskImage: "radial-gradient(circle,#000 60%,transparent 74%)", maskImage: "radial-gradient(circle,#000 60%,transparent 74%)" }}
          aria-hidden="true"
        >
          <div className="w-full h-full rounded-2xl bg-on-surface" />
        </div>

        <div className="relative max-w-[1100px] mx-auto px-6">
          {/* Eyebrow */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>gavel</span>
              {legal("legal")}
            </span>
          </div>

          <h1 lang={locale} dir={documentDir} className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">{uiText("m3b525be54f32")}</h1>
          <p className="bv-mono text-outline mt-3">{t("static.common.lastUpdated")}{" "}<time dateTime="2026-05">{updatedMonth}</time></p>

          {/* Doc switcher */}
          <div className="flex flex-wrap justify-center gap-2 mt-6">
            {[
              { label: legal("privacy"), href: "/privacy" },
              { label: legal("terms"), href: "/terms" },
              { label: legal("cookies"), href: "/cookies" },
              { label: "GDPR", href: "/gdpr" },
              { label: "KVKK", href: "/kvkk" },
              { label: legal("accountDeletion"), href: "/legal/account-deletion", active: true },
            ].map((doc) => (
              <a
                key={doc.href}
                href={doc.href}
                className={`bv-fpill ${doc.active ? "active" : ""}`}
              >
                {doc.label}
              </a>
            ))}
          </div>
        </div>
      </header>

      {/* ── Article grid (TOC + prose) ── */}
      <div className="max-w-[1040px] mx-auto px-6 md:px-8 mt-10 mb-24 grid grid-cols-1 md:grid-cols-[230px_1fr] gap-12">

        {/* Sticky TOC (desktop) */}
        <nav className="hidden md:block sticky self-start" style={{ top: "var(--bv-legal-offset)" }} aria-label={legal("onThisPage")}>
          <p className="bv-micro mb-[14px]">{legal("onThisPage")}</p>
          <div lang={locale} dir={documentDir} className="flex flex-col">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="text-[13px] leading-[1.3] text-on-surface-variant hover:text-on-surface py-[7px] px-[14px] border-l-2 border-outline-variant hover:border-primary transition-all"
              >
                {s.title}
              </a>
            ))}
          </div>
        </nav>

        {/* Prose */}
        <article lang={locale} dir={documentDir} className="max-w-[72ch] pb-24 bv-stagger">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="mb-0" style={{ scrollMarginTop: "var(--bv-legal-offset)" }}>
              {/* Section divider (skip first) */}
              <div className="bv-divider my-9 first:hidden" />

              <h2 className="font-headline font-semibold text-2xl uppercase tracking-tight text-on-surface mb-[14px] flex items-center gap-[10px] group">
                <span
                  className="material-symbols-outlined text-outline text-[20px] flex-shrink-0"
                  aria-hidden="true"
                >
                  {s.icon}
                </span>
                <span>{s.title}</span>
                <a
                  href={`#${s.id}`}
                  className="opacity-0 group-hover:opacity-100 text-[15px] text-primary no-underline transition-opacity"
                  aria-label={legal("permalinkTo", { title: s.title })}
                  lang={locale}
                  dir={locale === "ar" ? "rtl" : "ltr"}
                >
                  ¶
                </a>
              </h2>

              {s.content}
            </section>
          ))}

          {/* CTA card */}
          <div className="mt-10 bv-glass p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <p className="bv-title mb-1">{uiText("m22af538371f7")}</p>
              <p className="bv-caption">{uiText("mb5f06ea86d5e")}</p>
            </div>
            <div className="flex gap-3 flex-shrink-0">
              <a
                href="mailto:privacy@braavolabs.com?subject=Account%20deletion%20request"
                className="bv-btn bv-btn-ghost bv-btn-sm"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>{uiText("m7bc799542df6")}</a>
            </div>
          </div>
        </article>
      </div>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2.5 mb-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center bv-btn-primary bv-btn bv-btn-icon" style={{ padding: 0, minWidth: 28, minHeight: 28, width: 28, height: 28 }}>
                  <span className="text-white font-bold text-[10px] leading-none">AI</span>
                </div>
                <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
              </a>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {page("tagline")}
              </p>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{page("product")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{t("nav.features")}</a>
                <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{t("nav.pricing")}</a>
                <a href="/changelog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{t("static.changelog.title")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{page("company")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{page("about")}</a>
                <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{page("blog")}</a>
                <a href="/contact" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{t("static.contact.title")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{legal("legal")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/privacy" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{legal("privacy")}</a>
                <a href="/terms" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{legal("terms")}</a>
                <a href="/kvkk" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">KVKK</a>
                <a href="/gdpr" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">GDPR</a>
              </div>
            </div>
          </div>
          <div className="bv-divider" />
          <p className="text-sm text-outline mt-6 text-center">
            &copy; {new Date().getFullYear()}{" "}{uiText("m50591bb45e1e")}{" "}{page("rights")}
          </p>
        </div>
      </footer>
    </div>
  );
}
