import { getTranslations as getSeoTranslations } from "next-intl/server";

import { useTranslations as useLegacyTranslations } from "next-intl";
import type { Metadata } from "next";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("m3ca87fbbac15")),
  description:
    seo("m4bd9b811878a"),
  alternates: { canonical: "https://www.braavolabs.com/cost-calculator" },
  openGraph: {
    title: seo("m3ca87fbbac15"),
    description:
      seo("m81acc1f0380d"),
    url: "https://www.braavolabs.com/cost-calculator",
  },
};
}

const PLANNED_PLANS = [
  {
    name: "Individual",
    price: "$19/month",
    audience: "For one person using tenant-owned BYOK or a local model route.",
  },
  {
    name: "Team",
    price: "$39/active-user/month",
    audience: "For teams using tenant-owned BYOK or a local model route.",
  },
] as const;

export default function CostCalculatorPage() {
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div className="min-h-screen bv-mesh">
      <nav
        className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 md:px-10"
        style={{
          background: "var(--color-surface-container-low)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-xl text-white"
            style={{ background: "var(--bv-gradient-brand)" }}
            aria-hidden="true"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              bolt
            </span>
          </span>
          <span className="font-headline text-sm font-bold" style={{ color: "var(--color-on-surface)" }}>
            Braavolabs
          </span>
        </a>
        <div className="flex items-center gap-2">
          <a href="/pricing" className="bv-btn bv-btn-sm bv-btn-ghost no-underline">{uiText("mf2c79d7c83e6")}</a>
          <a href="https://app.braavolabs.com" className="bv-btn bv-btn-sm bv-btn-primary no-underline">{uiText("m3aaa432f7378")}</a>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6 py-16 md:px-10 md:py-24" data-public-surface="cost-calculator">
        <header className="max-w-3xl">
          <div className="bv-micro mb-3" style={{ color: "var(--color-primary)" }}>{uiText("m9680189524a4")}</div>
          <h1
            className="font-headline mb-5 font-bold uppercase"
            style={{
              fontSize: "clamp(36px, 7vw, 68px)",
              lineHeight: 0.96,
              letterSpacing: "-0.03em",
              color: "var(--color-on-surface)",
            }}
          >{uiText("m58ba90a040a3")}</h1>
          <p className="text-lg leading-relaxed" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("mfdf38497de3a")}</p>
        </header>

        <section className="mt-12 grid gap-5 md:grid-cols-2" aria-label={uiText("m0a048a01849e")}>
          {PLANNED_PLANS.map((plan) => (
            <article key={plan.name} className="bv-glass p-7">
              <p className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>{uiText("m865128d3e4d4")}</p>
              <h2 className="font-headline text-2xl font-bold" style={{ color: "var(--color-on-surface)" }}>
                {plan.name}
              </h2>
              <p className="bv-mono mt-3 text-xl" style={{ color: "var(--color-primary)" }}>
                {plan.price}
              </p>
              <p className="mt-4 leading-relaxed" style={{ color: "var(--color-on-surface-variant)" }}>
                {plan.audience}
              </p>
            </article>
          ))}
        </section>

        <aside className="bv-glass mt-8 p-7" aria-label={uiText("m4d17edf4bcc6")}>
          <h2 className="font-headline text-xl font-bold" style={{ color: "var(--color-on-surface)" }}>{uiText("m17a77e8ea42f")}</h2>
          <p className="mt-3 leading-relaxed" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("m52f120c3db8b")}</p>
        </aside>
      </main>
    </div>
  );
}
