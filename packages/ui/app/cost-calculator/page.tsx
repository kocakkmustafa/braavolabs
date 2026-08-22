"use client";

import { useState } from "react";

type Plan = "individual" | "team";

const PLAN_COPY: Record<Plan, { label: string; unitPrice: number; unit: string }> = {
  individual: {
    label: "Individual — $19/month",
    unitPrice: 19,
    unit: "one subscription",
  },
  team: {
    label: "Team — $39/active-user/month",
    unitPrice: 39,
    unit: "each active user",
  },
};

export default function CostCalculatorPage() {
  const [plan, setPlan] = useState<Plan>("individual");
  const [activeUsers, setActiveUsers] = useState(5);
  const selected = PLAN_COPY[plan];
  const billedUsers = plan === "team" ? activeUsers : 1;
  const monthlySubscription = selected.unitPrice * billedUsers;

  return (
    <div className="min-h-screen bv-mesh" data-public-surface="cost-calculator">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1040px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/pricing" className="hidden sm:inline text-sm text-on-surface-variant no-underline">Pricing</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">Sign in</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">Choose a plan</a>
          </div>
        </div>
      </nav>

      <main id="main-content" className="max-w-[1040px] mx-auto px-6 py-20">
        <header className="max-w-[760px]">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">Subscription estimator</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,72px)] leading-none">
            Calculate the platform subscription.
          </h1>
          <p className="text-on-surface-variant text-lg mt-6 leading-relaxed">
            This calculator covers the Braavolabs subscription only. Inference is not included.
            Use your own provider keys (BYOK) or local models.
          </p>
        </header>

        <section className="grid lg:grid-cols-[1fr_0.8fr] gap-6 mt-14">
          <div className="bv-glass p-8">
            <fieldset>
              <legend className="font-headline font-semibold text-xl">Select a plan</legend>
              <div className="grid sm:grid-cols-2 gap-3 mt-5">
                {(Object.keys(PLAN_COPY) as Plan[]).map((option) => (
                  <label
                    key={option}
                    className="rounded-xl border border-outline-variant p-4 cursor-pointer"
                    style={{ background: plan === option ? "rgba(59,130,246,0.10)" : undefined }}
                  >
                    <input
                      type="radio"
                      name="plan"
                      value={option}
                      checked={plan === option}
                      onChange={() => setPlan(option)}
                      className="mr-3"
                    />
                    <span className="font-semibold">{PLAN_COPY[option].label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {plan === "team" && (
              <label className="block mt-7">
                <span className="font-headline font-semibold text-lg">Active users</span>
                <span className="block text-sm text-on-surface-variant mt-1">
                  Only active users are included in this estimate.
                </span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={activeUsers}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    setActiveUsers(Number.isFinite(next) ? Math.max(1, next) : 1);
                  }}
                  className="mt-4 w-full rounded-xl border border-outline-variant bg-surface-container px-4 py-3"
                />
              </label>
            )}
          </div>

          <aside className="bv-glass p-8">
            <p className="bv-micro text-primary">Estimated monthly subscription</p>
            <p className="font-headline font-bold text-5xl mt-4">${monthlySubscription}</p>
            <p className="text-on-surface-variant mt-3">
              ${selected.unitPrice} × {billedUsers} {selected.unit}
            </p>
            <div className="bv-divider my-6" />
            <p className="text-sm text-on-surface-variant leading-relaxed">
              Provider token charges, local hardware, taxes, and any external service costs are outside this estimate.
            </p>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary justify-center no-underline mt-7">
              Continue to the authenticated app
            </a>
          </aside>
        </section>
      </main>
    </div>
  );
}
