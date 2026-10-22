
import { getTranslations as getLegacyTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PLAN_PRICING } from "@ai-company-os/core";
import { formatCurrency } from "../i18n/locales";
import LanguageSwitcher from "../components/LanguageSwitcher";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("publicPreview");
  return { title: `${t("homeTitle")} | Braavolabs`, description: t("homeIntro"),
    alternates: { canonical: "https://www.braavolabs.com" },
    openGraph: { title: t("homeTitle"), description: t("homeIntro"), url: "https://www.braavolabs.com", images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }] } };
}

const PUBLIC_LINKS = [
  ["features", "/features"], ["pricing", "/pricing"], ["security", "/security"],
  ["docs", "/docs"], ["cli", "/docs/getting-started"], ["status", "/status"], ["support", "/support"],
] as const;

export default async function HomePage() {
  const uiText = await getLegacyTranslations("uiCopy");
  const [t, locale] = await Promise.all([getTranslations("publicPreview"), getLocale()]);
  const modes = [{ name: t("privateMode"), copy: t("privateModeCopy") }, { name: t("cloudMode"), copy: t("cloudModeCopy") }];
  const price = (plan: "INDIVIDUAL" | "TEAM") => t(plan === "INDIVIDUAL" ? "individualPeriod" : "teamPeriod", {
    price: formatCurrency(PLAN_PRICING[plan].monthlyUsd, "USD", locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
  });
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="marketing">
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1120px] mx-auto px-4 sm:px-6 py-3 min-h-16 flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="font-headline font-bold text-on-surface no-underline">
            Braavolabs
          </a>
          <div className="hidden lg:flex items-center gap-5 text-sm text-on-surface-variant">
            {PUBLIC_LINKS.slice(0, 5).map(([label, href]) => (
              <a key={href} href={href} className="hover:text-on-surface transition-colors no-underline">
                {t(`links.${label}`)}
              </a>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LanguageSwitcher />
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
              {t("signIn")}
            </a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">
              {t("signUp")}
            </a>
          </div>
        </div>
      </nav>

      <main>
        <section className="max-w-[1120px] mx-auto px-6 pt-24 pb-16 text-center">
          <p className="bv-pill bv-pill-cyan inline-flex mb-6">{t("previewBadge")}</p>
          <h1 className="font-headline font-bold uppercase tracking-tight text-[clamp(42px,8vw,88px)] leading-[0.92] break-words" style={{ overflowWrap: "anywhere" }}>
            {t("homeTitle")}
          </h1>
          <p className="text-on-surface-variant text-lg max-w-[65ch] mx-auto mt-7 leading-relaxed">
            {t("homeIntro")}
          </p>
          <div className="flex flex-wrap justify-center gap-3 mt-9">
            <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-primary no-underline">
              {t("launchApp")}
            </a>
            <a href="/docs" className="bv-btn bv-btn-ghost no-underline">
              {t("readDocs")}
            </a>
          </div>
        </section>

        <section className="max-w-[1120px] mx-auto px-6 pb-16" aria-labelledby="planned-pricing">
          <p className="text-center bv-micro text-primary mb-3">{t("pricingBadge")}</p>
          <h2 id="planned-pricing" className="sr-only">{t("pricingTitle")}</h2>
          <div className="grid md:grid-cols-2 gap-5">
            <article className="bv-glass p-7">
              <p className="bv-micro text-primary mb-3">Individual</p>
              <h2 className="font-headline font-semibold text-3xl">{uiText("me9694a186010")}{" "}<bdi>{price("INDIVIDUAL")}</bdi></h2>
              <p className="text-on-surface-variant mt-3">{t("individualSummary")}</p>
            </article>
            <article className="bv-glass p-7">
              <p className="bv-micro text-primary mb-3">Team</p>
              <h2 className="font-headline font-semibold text-3xl">{uiText("m032b7cca868a")}{" "}<bdi>{price("TEAM")}</bdi></h2>
              <p className="text-on-surface-variant mt-3">{t("teamSummary")}</p>
            </article>
          </div>
          <p className="text-center text-on-surface-variant mt-5">
            {t("inferenceFunding")}
          </p>
        </section>

        <section className="max-w-[1120px] mx-auto px-6 pb-16">
          <div className="grid md:grid-cols-2 gap-5">
            {modes.map((mode) => (
              <article key={mode.name} className="bv-glass p-7">
                <p className="bv-micro text-primary mb-3">{t("dataMode")}</p>
                <h2 className="font-headline font-semibold text-2xl">{mode.name}</h2>
                <p className="text-on-surface-variant mt-3 leading-relaxed">{mode.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="max-w-[1120px] mx-auto px-6 pb-24">
          <div className="bv-glass p-7 grid md:grid-cols-2 gap-8">
            <div>
              <p className="bv-micro text-primary mb-3">{t("maturity")}</p>
              <h2 className="font-headline font-semibold text-2xl">{t("holding")}</h2>
              <p className="text-on-surface-variant mt-3">{t("holdingCopy")}</p>
            </div>
            <div>
              <p className="bv-micro text-primary mb-3">{t("verification")}</p>
              <h2 className="font-headline font-semibold text-2xl">{t("signedEvidence")}</h2>
              <p className="text-on-surface-variant mt-3">{t("signedEvidenceCopy")}</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-outline-variant">
        <div className="max-w-[1120px] mx-auto px-6 py-10 flex flex-wrap items-center justify-between gap-5 text-sm">
          <span className="text-on-surface-variant">{uiText("m37d5c6a2c645")}</span>
          <div className="flex flex-wrap gap-5">
            {/* Below lg the header hides these links; keep them reachable here. */}
            {PUBLIC_LINKS.slice(0, 5).map(([label, href]) => (
              <a key={href} href={href} className="lg:hidden text-on-surface-variant hover:text-on-surface no-underline">
                {t(`links.${label}`)}
              </a>
            ))}
            {PUBLIC_LINKS.slice(5).map(([label, href]) => (
              <a key={href} href={href} className="text-on-surface-variant hover:text-on-surface no-underline">
                {t(`links.${label}`)}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
