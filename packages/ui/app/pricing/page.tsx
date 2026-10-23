import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PLAN_PRICING } from "@ai-company-os/core";
import { bidiIsolate, formatCurrency, localeDirection } from "../../i18n/locales";
import LanguageSwitcher from "../../components/LanguageSwitcher";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const [t, seo] = await Promise.all([getTranslations("publicPreview"), getTranslations("seo")]);
  // Page metadata replaces the layout's: keep the planned-pricing maturity line.
  const description = seo("m907e61f93ecc");
  return { title: brandTitle(`${t("pricingTitle")} | Braavolabs`), description,
    alternates: { canonical: "https://www.braavolabs.com/pricing" },
    openGraph: { title: t("pricingTitle"), description, url: "https://www.braavolabs.com/pricing", images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }] } };
}

export default async function PricingPage() {
  const [t, locale] = await Promise.all([getTranslations("publicPreview"), getLocale()]);
  const plans = (["INDIVIDUAL", "TEAM"] as const).map(id => ({
    name: id === "INDIVIDUAL" ? "Individual" : "Team",
    price: t(id === "INDIVIDUAL" ? "individualPeriod" : "teamPeriod", { price: bidiIsolate(formatCurrency(PLAN_PRICING[id].monthlyUsd, "USD", locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }), locale) }),
    audience: t(id === "INDIVIDUAL" ? "individualAudience" : "teamAudience"),
    items: t.raw(id === "INDIVIDUAL" ? "individualItems" : "teamItems") as string[],
  }));
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="pricing">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1080px] mx-auto px-4 sm:px-6 py-3 min-h-16 flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex flex-wrap items-center gap-3">
            <LanguageSwitcher />
            <a href="/features" className="hidden sm:inline text-sm text-on-surface-variant no-underline">{t("links.features")}</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">{t("signIn")}</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">{t("signUp")}</a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1080px] mx-auto px-6 py-20">
        <header className="text-center max-w-[720px] mx-auto">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">{t("pricingBadge")}</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,72px)] leading-none" style={{ overflowWrap: "anywhere" }}>{t("pricingTitle")}</h1>
          <p className="text-on-surface-variant text-lg mt-6">
            {t("inferenceFunding")}
          </p>
        </header>

        <section className="grid md:grid-cols-2 gap-6 mt-14">
          {plans.map((plan) => (
            <article key={plan.name} className="bv-glass p-8 flex flex-col">
              <p className="bv-micro text-primary mb-3">{t("subscription")}</p>
              <h2 className="font-headline font-semibold text-3xl"><bdi dir={localeDirection(locale)}>{`${plan.name} — ${plan.price}`}</bdi></h2>
              <p className="text-on-surface-variant mt-4 leading-relaxed">{plan.audience}</p>
              <ul className="mt-7 flex-1 space-y-3 text-on-surface-variant">
                {plan.items.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden className="text-primary">✓</span>{item}
                  </li>
                ))}
              </ul>
              <p className="bv-btn bv-btn-ghost justify-center mt-8" aria-label={t("unavailableLabel", { plan: plan.name })}>
                {t("unavailable")}
              </p>
            </article>
          ))}
        </section>

        <section className="bv-glass p-8 mt-6 grid md:grid-cols-2 gap-8">
          <div>
            <p className="bv-micro text-primary mb-3">{t("privateMode")}</p>
            <p className="text-on-surface-variant leading-relaxed">
              {t("privateModeCopy")}
            </p>
          </div>
          <div>
            <p className="bv-micro text-primary mb-3">{t("cloudMode")}</p>
            <p className="text-on-surface-variant leading-relaxed">
              {t("cloudModeCopy")}
            </p>
          </div>
        </section>

        <section className="text-center mt-12">
          <p className="font-headline font-semibold text-xl">{t("holding")}</p>
          <p className="text-on-surface-variant mt-2">{t("holdingSubscription")}</p>
          <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-ghost no-underline mt-6">{t("launchApp")}</a>
        </section>
      </main>
    </div>
  );
}
