import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing Preview — Braavolabs",
  description:
    "Preview the planned Braavolabs Individual and Team subscription prices. Purchasing is not currently available and inference is not included.",
  alternates: { canonical: "https://www.braavolabs.com/cost-calculator" },
  openGraph: {
    title: "Pricing Preview — Braavolabs",
    description:
      "Planned pricing for Individual and Team. Purchasing is not currently available and inference is not included.",
    url: "https://www.braavolabs.com/cost-calculator",
  },
};

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
  return (
    <div className="min-h-screen bv-mesh">
      <nav
        className="sticky top-0 z-30 flex items-center justify-between px-6 py-4 md:px-10"
        style={{
          background: "rgba(6,7,10,0.72)",
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
          <a href="/pricing" className="bv-btn bv-btn-sm bv-btn-ghost no-underline">
            Pricing
          </a>
          <a href="https://app.braavolabs.com" className="bv-btn bv-btn-sm bv-btn-primary no-underline">
            Open app
          </a>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6 py-16 md:px-10 md:py-24" data-public-surface="cost-calculator">
        <header className="max-w-3xl">
          <div className="bv-micro mb-3" style={{ color: "var(--color-primary)" }}>
            Pricing preview — not currently purchasable
          </div>
          <h1
            className="font-headline mb-5 font-bold uppercase"
            style={{
              fontSize: "clamp(36px, 7vw, 68px)",
              lineHeight: 0.96,
              letterSpacing: "-0.03em",
              color: "var(--color-on-surface)",
            }}
          >
            Planned subscription pricing
          </h1>
          <p className="text-lg leading-relaxed" style={{ color: "var(--color-on-surface-variant)" }}>
            Billing migration is still in development, so this page does not calculate a payable quote or begin a
            purchase. The planned catalog contains only Individual and Team.
          </p>
        </header>

        <section className="mt-12 grid gap-5 md:grid-cols-2" aria-label="Planned plans">
          {PLANNED_PLANS.map((plan) => (
            <article key={plan.name} className="bv-glass p-7">
              <p className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
                Planned plan
              </p>
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

        <aside className="bv-glass mt-8 p-7" aria-label="Inference cost notice">
          <h2 className="font-headline text-xl font-bold" style={{ color: "var(--color-on-surface)" }}>
            Inference is not included
          </h2>
          <p className="mt-3 leading-relaxed" style={{ color: "var(--color-on-surface-variant)" }}>
            Model usage is paid to the provider you configure through BYOK, or runs through your own local model
            route. Braavolabs does not currently offer these planned subscriptions for purchase.
          </p>
        </aside>
      </main>
    </div>
  );
}
