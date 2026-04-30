"use client";

import { useState } from "react";

type BillingCycle = "monthly" | "yearly";

interface Plan {
  name: string;
  priceMonthly: number | "custom";
  priceYearlyMonthlyEquivalent: number;
  period: string;
  desc: string;
  features: string[];
  cta: string;
  highlight: boolean;
  badge: string | null;
}

const PLANS: Plan[] = [
  {
    name: "Free",
    priceMonthly: 0,
    priceYearlyMonthlyEquivalent: 0,
    period: "forever",
    desc: "Real AI output from day one. Build 1 company, see it work.",
    features: [
      "1 AI company",
      "10 runs / month",
      "TikTok + LinkedIn channels",
      "Simplified hero template",
      "Full audit log",
      "Cloud BYOK (Anthropic / OpenAI / Gemini)",
      "Community support",
    ],
    cta: "Start Free",
    highlight: false,
    badge: null,
  },
  {
    name: "Creator",
    priceMonthly: 19,
    priceYearlyMonthlyEquivalent: 15.2,
    period: "/ month",
    desc: "For solopreneurs running a handful of AI companies.",
    features: [
      "5 companies running in parallel",
      "100 runs / month",
      "All channels (TikTok, LinkedIn, IG, X, Email)",
      "Custom pipelines",
      "Memory engine",
      "Self-hosted Gemma (Ollama / LM Studio)",
      "Email support",
    ],
    cta: "Choose Creator",
    highlight: false,
    badge: null,
  },
  {
    name: "Pro",
    priceMonthly: 39,
    priceYearlyMonthlyEquivalent: 31.2,
    period: "/ month",
    desc: "For agencies and founders scaling across many brands.",
    features: [
      "20 companies",
      "500 runs / month",
      "HubSpot CRM sync",
      "Outreach automation",
      "Advanced analytics",
      "Self-hosted Gemma + Custom OpenAI endpoints",
      "Priority support",
    ],
    cta: "Choose Pro",
    highlight: true,
    badge: "Most Popular",
  },
  {
    name: "Business",
    priceMonthly: 99,
    priceYearlyMonthlyEquivalent: 79.2,
    period: "/ month",
    desc: "Team-scale autonomy with governance built in.",
    features: [
      "100 companies",
      "2,000 runs / month",
      "3 team seats",
      "Governance + audit export",
      "White-label prep",
      "Self-hosted LLM + air-gapped option",
      "Dedicated support",
    ],
    cta: "Choose Business",
    highlight: false,
    badge: null,
  },
];

const ENTERPRISE: Plan = {
  name: "Enterprise",
  priceMonthly: "custom",
  priceYearlyMonthlyEquivalent: 0,
  period: "",
  desc: "Unlimited companies, SSO, SLA, private deployment.",
  features: ["Unlimited companies & runs", "SSO + SAML", "Dedicated SLA", "Custom integrations", "Private deployment option", "White-label"],
  cta: "Talk to Sales",
  highlight: false,
  badge: null,
};

function formatMonthly(n: number) {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export default function PricingPage() {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <div className="flex items-center gap-4 text-sm" style={{ color: "#859399" }}>
          <a href="/features" className="hover:text-white transition-colors">Features</a>
          <a href="/docs" className="hover:text-white transition-colors">Docs</a>
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            Get Started
          </a>
        </div>
      </nav>

      <div className="max-w-[1100px] mx-auto px-6 py-16">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#00d1ff" }} />
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>FREE TO START · NO CARD REQUIRED</span>
          </div>
          <h1 className="font-headline font-extrabold mb-3"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#e1e2eb", lineHeight: 1.1 }}>
            Simple, transparent pricing
          </h1>
          <p style={{ color: "#859399", maxWidth: 520, margin: "0 auto" }}>
            Start free with one AI company. Upgrade when you want to run more. Every paid plan is 20% cheaper on annual billing.
          </p>
        </div>

        {/* Billing cycle toggle */}
        <div className="flex justify-center mb-10">
          <div className="inline-flex items-center gap-1 p-1 rounded-xl"
            style={{ background: "rgba(29,32,38,0.9)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <button
              onClick={() => setCycle("monthly")}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{
                background: cycle === "monthly" ? "linear-gradient(135deg, #00d1ff, #6d11ad)" : "transparent",
                color: cycle === "monthly" ? "white" : "#859399",
              }}
            >
              Monthly
            </button>
            <button
              onClick={() => setCycle("yearly")}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-2"
              style={{
                background: cycle === "yearly" ? "linear-gradient(135deg, #00d1ff, #6d11ad)" : "transparent",
                color: cycle === "yearly" ? "white" : "#859399",
              }}
            >
              Yearly
              <span className="px-1.5 py-0.5 text-[10px] rounded-md font-bold"
                style={{
                  background: cycle === "yearly" ? "rgba(255,255,255,0.2)" : "rgba(52,211,153,0.15)",
                  color: cycle === "yearly" ? "white" : "#34d399",
                }}>
                −20%
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {PLANS.map((plan) => {
            const displayPrice =
              plan.priceMonthly === 0
                ? "$0"
                : cycle === "yearly"
                  ? formatMonthly(plan.priceYearlyMonthlyEquivalent)
                  : formatMonthly(plan.priceMonthly as number);
            const displayPeriod = plan.priceMonthly === 0 ? "forever" : cycle === "yearly" ? "/ mo · billed yearly" : "/ month";
            return (
              <div key={plan.name} className="relative flex flex-col p-6 rounded-2xl"
                style={{
                  background: plan.highlight ? "rgba(0,209,255,0.05)" : "rgba(29,32,38,0.7)",
                  border: plan.highlight ? "1.5px solid rgba(0,209,255,0.3)" : "1px solid rgba(255,255,255,0.05)",
                  boxShadow: plan.highlight ? "0 0 40px rgba(0,209,255,0.07)" : "none",
                }}>
                {plan.badge && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-bold text-white whitespace-nowrap"
                    style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
                    {plan.badge}
                  </span>
                )}
                <div className="mb-5">
                  <p className="font-headline font-semibold mb-1 text-sm" style={{ color: "#e1e2eb" }}>{plan.name}</p>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span className="font-headline font-black text-3xl"
                      style={{ color: plan.highlight ? "#00d1ff" : "#e1e2eb" }}>{displayPrice}</span>
                    <span className="text-xs" style={{ color: "#859399" }}>{displayPeriod}</span>
                  </div>
                  <p className="text-xs" style={{ color: "#859399" }}>{plan.desc}</p>
                </div>

                <ul className="space-y-2.5 mb-7 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs" style={{ color: "#bbc9cf" }}>
                      <span className="material-symbols-outlined text-sm mt-0.5" style={{ color: plan.highlight ? "#00d1ff" : "#3c494e" }}>
                        check
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <a href="/login"
                  className="block text-center py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{
                    background: plan.highlight ? "linear-gradient(135deg, #00d1ff, #6d11ad)" : "rgba(255,255,255,0.06)",
                    color: plan.highlight ? "white" : "#bbc9cf",
                    border: plan.highlight ? "none" : "1px solid rgba(255,255,255,0.08)",
                  }}>
                  {plan.cta}
                </a>
              </div>
            );
          })}
        </div>

        {/* Enterprise strip */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 p-6 rounded-2xl"
          style={{ background: "rgba(109,17,173,0.05)", border: "1px solid rgba(109,17,173,0.25)" }}>
          <div>
            <p className="font-headline font-semibold text-sm mb-1" style={{ color: "#e1e2eb" }}>Need more?</p>
            <p className="text-xs" style={{ color: "#859399" }}>
              Enterprise — unlimited companies, SSO, private deployment, dedicated SLA.
            </p>
          </div>
          <a href="mailto:founder@braavolabs.com" className="px-5 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap"
            style={{ background: "rgba(255,255,255,0.06)", color: "#e1e2eb", border: "1px solid rgba(255,255,255,0.08)", textDecoration: "none" }}>
            Talk to the Founder
          </a>
        </div>

        {/* FAQ strip */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { q: "Do I need a credit card for the free plan?", a: "No. Free is completely free forever — no card required. You get 1 company and 10 runs per month, with real AI output." },
            { q: "What counts as a 'run'?", a: "Each pipeline execution is one run. Example: 1 TikTok post generation = 1 run. 1 email outreach sequence = 1 run." },
            { q: "Why is there no free trial on paid plans?", a: "Because the Free plan already gives you real value. Try the product for free, then pick a tier when you're ready for more companies." },
            { q: "What if I exceed my run quota?", a: "Your pipelines pause until next month or until you upgrade. No surprise charges." },
            { q: "Can I cancel anytime?", a: "Yes. Cancel from your billing page at any time — no penalty, no lock-in. Keep access until your period ends." },
            { q: "Is my data private?", a: "Yes. Each tenant is fully isolated. We never share or train on your company data." },
          ].map((item) => (
            <div key={item.q} className="p-5 rounded-xl"
              style={{ background: "rgba(29,32,38,0.5)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <p className="font-semibold text-sm mb-1.5" style={{ color: "#e1e2eb" }}>{item.q}</p>
              <p className="text-xs leading-relaxed" style={{ color: "#859399" }}>{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
