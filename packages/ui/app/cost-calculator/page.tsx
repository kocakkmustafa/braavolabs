"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PLAN_PRICING } from "@ai-company-os/core";

// ── Pricing (real, from packages/core/src/constants/plans.ts → PLAN_PRICING) ──
// We pick the cheapest paid plan whose monthly run cap covers your volume.
// Run caps come from PLAN_LIMITS in the same file (Free 10 · Creator 100 ·
// Pro 500 · Business 2000 runs/month).
const PLAN_TIERS = [
  { id: "FREE", label: "Free", monthly: PLAN_PRICING.FREE.monthlyUsd, maxRuns: 10 },
  { id: "CREATOR", label: "Creator", monthly: PLAN_PRICING.CREATOR.monthlyUsd, maxRuns: 100 },
  { id: "PRO", label: "Pro", monthly: PLAN_PRICING.PRO.monthlyUsd, maxRuns: 500 },
  { id: "BUSINESS", label: "Business", monthly: PLAN_PRICING.BUSINESS.monthlyUsd, maxRuns: 2000 },
] as const;

// ── Estimate constants (clearly-labelled, illustrative) ──────────────
// BYOK token estimate: a rough per-step token figure × a representative
// blended model price. Both are deliberately conservative and labelled an
// estimate everywhere they surface — your real cost depends on your model,
// prompt sizes, and provider.
const TOKENS_PER_STEP = 4000; // input+output, rough average for a tool-using step
const USD_PER_1K_TOKENS = 0.004; // blended illustrative rate across BYOK providers

// Per-task automation rate — illustrative only. Based on published task-tier
// math for typical workflow-automation pricing (commonly in the ~$0.02–0.03
// per-task range on paid tiers). This is NOT any specific competitor's exact
// price; it stands in for "the meter ticks on every task you run."
const PER_TASK_RATE = 0.025;

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function pickPlan(runsPerMonth: number) {
  for (const tier of PLAN_TIERS) {
    if (runsPerMonth <= tier.maxRuns) return tier;
  }
  // Above the Business cap → Business is still the flat anchor (Enterprise is
  // custom-priced, so we don't quote a number for it here).
  return PLAN_TIERS[PLAN_TIERS.length - 1];
}

interface FieldProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function SliderField({ label, hint, value, min, max, step, onChange }: FieldProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <label className="font-headline font-semibold" style={{ fontSize: 15, color: "var(--color-on-surface)" }}>
          {label}
        </label>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isNaN(n)) return;
            onChange(Math.max(min, Math.min(max, n)));
          }}
          className="bv-mono"
          style={{
            width: 96,
            textAlign: "right",
            background: "var(--color-surface-container)",
            border: "1px solid var(--bv-glass-border)",
            borderRadius: 8,
            color: "var(--color-on-surface)",
            padding: "6px 10px",
            fontSize: 14,
          }}
          aria-label={label}
        />
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bv-range"
        style={{
          width: "100%",
          accentColor: "#3B82F6",
          background: `linear-gradient(to right, #3B82F6 ${pct}%, rgba(255,255,255,0.08) ${pct}%)`,
        }}
        aria-label={`${label} slider`}
      />
      <p className="bv-caption mt-1.5" style={{ color: "var(--color-outline)" }}>
        {hint}
      </p>
    </div>
  );
}

export default function CostCalculatorPage() {
  const [runs, setRuns] = useState(120);
  const [steps, setSteps] = useState(8);
  const [actions, setActions] = useState(2);

  const calc = useMemo(() => {
    const plan = pickPlan(runs);
    const totalSteps = runs * steps;

    // Braavolabs side: flat plan + your own BYOK API spend (estimate).
    const byokTokens = totalSteps * TOKENS_PER_STEP;
    const byokCost = (byokTokens / 1000) * USD_PER_1K_TOKENS;
    const braavoTotal = plan.monthly + byokCost;

    // Per-task model side: tasks ≈ runs × steps × actions, billed per task.
    const tasks = totalSteps * Math.max(1, actions);
    const perTaskCost = tasks * PER_TASK_RATE;

    return { plan, totalSteps, byokTokens, byokCost, braavoTotal, tasks, perTaskCost };
  }, [runs, steps, actions]);

  const cheaper = calc.braavoTotal <= calc.perTaskCost;

  return (
    <div className="min-h-screen bv-mesh">
      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-30 flex items-center justify-between px-6 md:px-10 py-4"
        style={{
          background: "rgba(6,7,10,0.72)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--bv-gradient-brand)" }}
          >
            <span className="material-symbols-outlined text-white" style={{ fontSize: "16px" }}>
              bolt
            </span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "var(--color-on-surface)" }}>
            Braavolabs
          </span>
        </a>

        <div className="hidden md:flex items-center gap-6">
          {(["Features", "Pricing", "Compare", "Blog"] as const).map((label) => (
            <a
              key={label}
              href={label === "Blog" ? "/blog" : `/${label.toLowerCase()}`}
              className="text-sm transition-colors hover:text-white no-underline"
              style={{ color: "var(--color-on-surface-variant)" }}
            >
              {label}
            </a>
          ))}
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

      <main>
        {/* ── Page head ── */}
        <header className="max-w-5xl mx-auto px-6 md:px-10 pt-16 pb-8">
          <div className="bv-micro mb-3" style={{ color: "var(--color-primary)" }}>
            Cost calculator
          </div>
          <h1
            className="font-headline font-bold mb-4"
            style={{
              fontSize: "clamp(34px, 6vw, 60px)",
              lineHeight: 0.96,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
              color: "var(--color-on-surface)",
            }}
          >
            Flat &amp; predictable<br />vs. priced per step.
          </h1>
          <p className="leading-relaxed" style={{ color: "var(--color-on-surface-variant)", maxWidth: "62ch", fontSize: "17px" }}>
            On a flat plan, your subscription doesn&apos;t move when a run gets longer — you only pay your own
            model bill on top, on your own keys. On a per-task meter, every extra step is another charge. Slide
            the inputs and watch which line stays still.
          </p>
        </header>

        {/* ── Calculator ── */}
        <section className="px-6 md:px-10 pb-4">
          <div className="max-w-5xl mx-auto grid gap-5 lg:grid-cols-2">
            {/* Inputs */}
            <div className="bv-glass flex flex-col gap-7" style={{ padding: "30px 32px" }}>
              <div className="bv-micro" style={{ color: "var(--color-outline)" }}>
                Your usage
              </div>
              <SliderField
                label="Runs per month"
                hint="How many times you kick off a pipeline."
                value={runs}
                min={10}
                max={2000}
                step={10}
                onChange={setRuns}
              />
              <SliderField
                label="Avg steps per run"
                hint="Steps the agent takes inside a single run."
                value={steps}
                min={1}
                max={40}
                step={1}
                onChange={setSteps}
              />
              <SliderField
                label="Avg actions per step (optional)"
                hint="External app calls each step makes — drives per-task billing."
                value={actions}
                min={1}
                max={8}
                step={1}
                onChange={setActions}
              />

              <div className="bv-divider" />
              <div className="flex items-center justify-between" style={{ fontSize: 13 }}>
                <span style={{ color: "var(--color-on-surface-variant)" }}>Total steps / month</span>
                <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>
                  {calc.totalSteps.toLocaleString("en-US")}
                </span>
              </div>
              <div className="flex items-center justify-between" style={{ fontSize: 13, marginTop: -12 }}>
                <span style={{ color: "var(--color-on-surface-variant)" }}>Billable tasks (per-task model)</span>
                <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>
                  {calc.tasks.toLocaleString("en-US")}
                </span>
              </div>
            </div>

            {/* Results */}
            <div className="flex flex-col gap-5">
              {/* Braavolabs card */}
              <div
                className="bv-glass"
                style={{
                  padding: "26px 28px",
                  border: "1px solid rgba(96,165,250,0.45)",
                  boxShadow:
                    "inset 0 1px 0 rgba(255,255,255,0.05), 0 0 50px -16px rgba(59,130,246,0.5), 0 24px 50px -28px rgba(0,0,0,0.9)",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    background: "linear-gradient(115deg, transparent 34%, rgba(125,211,252,0.08) 48%, transparent 62%)",
                    animation: "bv-sheen 5s ease-in-out infinite",
                  }}
                />
                <div className="flex items-center justify-between mb-1">
                  <span className="font-headline font-semibold uppercase" style={{ fontSize: 18, color: "#60A5FA", letterSpacing: "-0.02em" }}>
                    Braavolabs
                  </span>
                  <span className="bv-pill bv-pill-cyan" style={{ fontSize: 10, letterSpacing: "0.10em" }}>
                    Flat
                  </span>
                </div>
                <div style={{ lineHeight: 1, marginBottom: 4 }}>
                  <span className="font-headline font-semibold" style={{ fontSize: 46, color: "#60A5FA", letterSpacing: "-0.02em" }}>
                    {fmtUsd(calc.braavoTotal)}
                  </span>
                  <span className="ml-1 text-sm" style={{ color: "var(--color-on-surface-variant)" }}>
                    / month
                  </span>
                </div>
                <div className="flex flex-col gap-2 mt-4">
                  <div className="flex items-center justify-between" style={{ fontSize: 13.5 }}>
                    <span style={{ color: "var(--color-on-surface-variant)" }}>
                      {calc.plan.label} plan {calc.plan.monthly === 0 ? "(free)" : "(flat)"}
                    </span>
                    <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>
                      {fmtUsd(calc.plan.monthly)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between" style={{ fontSize: 13.5 }}>
                    <span style={{ color: "var(--color-on-surface-variant)" }}>
                      Your BYOK API spend{" "}
                      <span style={{ color: "#FF7A1A", fontSize: 11 }}>≈ estimate</span>
                    </span>
                    <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>
                      {fmtUsd(calc.byokCost)}
                    </span>
                  </div>
                </div>
                <p className="bv-caption mt-4" style={{ color: "var(--color-outline)", lineHeight: 1.5 }}>
                  Plan price is fixed. Only the BYOK line moves with volume — and it&apos;s your own model bill on
                  your own keys, not our markup.
                </p>
              </div>

              {/* Per-task card */}
              <div className="bv-glass" style={{ padding: "26px 28px" }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-headline font-semibold uppercase" style={{ fontSize: 18, color: "var(--color-on-surface)", letterSpacing: "-0.02em" }}>
                    Per-task model
                  </span>
                  <span
                    className="bv-mono"
                    style={{ fontSize: 10, letterSpacing: "0.10em", color: "#FF7A1A", border: "1px solid rgba(255,122,26,0.35)", borderRadius: 999, padding: "3px 9px" }}
                  >
                    ILLUSTRATIVE
                  </span>
                </div>
                <div style={{ lineHeight: 1, marginBottom: 4 }}>
                  <span className="font-headline font-semibold" style={{ fontSize: 46, color: "var(--color-on-surface)", letterSpacing: "-0.02em" }}>
                    {fmtUsd(calc.perTaskCost)}
                  </span>
                  <span className="ml-1 text-sm" style={{ color: "var(--color-on-surface-variant)" }}>
                    / month
                  </span>
                </div>
                <div className="flex items-center justify-between mt-4" style={{ fontSize: 13.5 }}>
                  <span style={{ color: "var(--color-on-surface-variant)" }}>
                    {calc.tasks.toLocaleString("en-US")} tasks × ~${PER_TASK_RATE.toFixed(3)}
                  </span>
                  <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>
                    {fmtUsd(calc.perTaskCost)}
                  </span>
                </div>
                <p className="bv-caption mt-4" style={{ color: "var(--color-outline)", lineHeight: 1.5 }}>
                  Typical per-task automation pricing — every step (and each action within it) is a billable
                  task, so the total climbs with run depth. Figure is illustrative, based on published task-tier
                  math; it is not any specific vendor&apos;s exact rate.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── The takeaway ── */}
        <section className="px-6 md:px-10 pt-6">
          <div className="max-w-5xl mx-auto">
            <div
              className="bv-glass flex items-start gap-4"
              style={{ padding: "24px 28px", border: "1px solid rgba(37,99,235,0.25)", background: "rgba(37,99,235,0.04)" }}
            >
              <span className="material-symbols-outlined flex-none" style={{ color: "#60A5FA", fontSize: 24, marginTop: 2 }}>
                {cheaper ? "trending_down" : "balance"}
              </span>
              <div>
                <p className="font-headline font-semibold mb-1" style={{ fontSize: 17, color: "var(--color-on-surface)" }}>
                  The point isn&apos;t a magic number — it&apos;s predictability.
                </p>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6, maxWidth: "72ch" }}>
                  Push <span style={{ color: "var(--color-on-surface)" }}>steps per run</span> up and the
                  per-task line climbs while the Braavolabs plan price holds flat. That&apos;s the difference
                  between a bill you can forecast and one that scales with every step. Your real numbers will
                  differ — these are estimates to show the <em>shape</em> of each model, not a quote.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Assumptions ── */}
        <section className="px-6 md:px-10 pt-12">
          <div className="max-w-5xl mx-auto">
            <h2 className="bv-micro mb-4" style={{ color: "var(--color-outline)" }}>
              What&apos;s behind these numbers
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  t: "Flat plan pricing — real",
                  d: `Free $0 · Creator $${PLAN_PRICING.CREATOR.monthlyUsd} · Pro $${PLAN_PRICING.PRO.monthlyUsd} · Business $${PLAN_PRICING.BUSINESS.monthlyUsd}/mo. We pick the cheapest plan whose monthly run cap fits your volume.`,
                  real: true,
                },
                {
                  t: "BYOK estimate",
                  d: `~${TOKENS_PER_STEP.toLocaleString("en-US")} tokens/step × ~$${USD_PER_1K_TOKENS.toFixed(3)}/1K (blended). Your real cost depends on your model, prompts, and provider.`,
                  real: false,
                },
                {
                  t: "Per-task rate — illustrative",
                  d: `~$${PER_TASK_RATE.toFixed(3)}/task, in the typical published task-tier range. A stand-in for "the meter ticks on every task," not a specific competitor's price.`,
                  real: false,
                },
              ].map((a) => (
                <div key={a.t} className="bv-glass" style={{ padding: "18px 20px" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="bv-mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.08em",
                        color: a.real ? "#60A5FA" : "#FF7A1A",
                        border: `1px solid ${a.real ? "rgba(96,165,250,0.35)" : "rgba(255,122,26,0.35)"}`,
                        borderRadius: 999,
                        padding: "2px 8px",
                      }}
                    >
                      {a.real ? "REAL" : "ESTIMATE"}
                    </span>
                    <h3 className="font-headline font-semibold" style={{ fontSize: 14.5, color: "var(--color-on-surface)" }}>
                      {a.t}
                    </h3>
                  </div>
                  <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", fontSize: 13, lineHeight: 1.55 }}>
                    {a.d}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="px-6 md:px-10 pt-14 pb-4">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-3">
            <a href="/register" className="bv-btn bv-btn-primary bv-sheen no-underline">
              Start free
            </a>
            <a href="/pricing" className="bv-btn bv-btn-ghost no-underline">
              See full pricing
            </a>
            <Link href="/compare" className="bv-btn bv-btn-ghost no-underline">
              How we compare
            </Link>
          </div>
        </section>

        {/* ── Trust strip ── */}
        <section className="px-6 md:px-10 pt-12 pb-4 text-center">
          <div className="max-w-5xl mx-auto">
            <div className="bv-divider mb-8" />
            <p className="bv-mono" style={{ color: "var(--color-on-surface-variant)", letterSpacing: "0.04em", fontSize: 13 }}>
              Flat plans · bring your own keys · no per-step surprises
            </p>
            <p className="bv-caption mt-3" style={{ color: "var(--color-outline)" }}>
              Paid plans bill as in-app subscriptions via the App Store / Google Play.
            </p>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t" style={{ borderColor: "rgba(58,65,80,0.18)" }}>
        <div className="max-w-5xl mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2 mb-3 no-underline">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--bv-gradient-brand)" }}
                >
                  <span className="material-symbols-outlined text-white" style={{ fontSize: "14px" }}>
                    bolt
                  </span>
                </div>
                <span className="font-headline font-bold text-sm" style={{ color: "var(--color-on-surface)" }}>
                  Braavolabs
                </span>
              </a>
              <p className="text-xs leading-relaxed" style={{ color: "var(--color-on-surface-variant)", maxWidth: "22ch" }}>
                Command the AI agents &amp; automations you already run.
              </p>
            </div>

            <div>
              <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
                Product
              </h5>
              {["Features", "Pricing", "Integrations", "Changelog"].map((link) => (
                <a
                  key={link}
                  href={`/${link.toLowerCase()}`}
                  className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                  style={{ color: "var(--color-on-surface-variant)" }}
                >
                  {link}
                </a>
              ))}
            </div>

            <div>
              <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
                Company
              </h5>
              {["About", "Blog", "Contact", "Status"].map((link) => (
                <a
                  key={link}
                  href={link === "Blog" ? "/blog" : `/${link.toLowerCase()}`}
                  className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                  style={{ color: "var(--color-on-surface-variant)" }}
                >
                  {link}
                </a>
              ))}
            </div>

            <div>
              <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
                Legal
              </h5>
              {[
                { label: "Privacy", href: "/privacy" },
                { label: "Terms", href: "/terms" },
                { label: "Security", href: "/security" },
                { label: "GDPR", href: "/gdpr" },
              ].map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                  style={{ color: "var(--color-on-surface-variant)" }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>

          <div className="bv-divider my-8" />

          <p className="bv-mono text-center" style={{ color: "var(--color-outline)", fontSize: "11px" }}>
            © 2026 Braavolabs. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
