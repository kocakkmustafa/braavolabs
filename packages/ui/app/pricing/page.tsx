"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import LanguageSwitcher from "../../components/LanguageSwitcher";

type BillingCycle = "monthly" | "yearly";

// Numeric/visual config only — copy lives under pricing.plans.<id> in
// messages/*.json so the entire page localises with one language switch.
// Order here drives card order; ids must match the JSON keys exactly.
const PLANS: Array<{
  id: "free" | "creator" | "pro" | "business";
  priceMonthly: number;
  priceYearlyMonthlyEquivalent: number;
  highlight: boolean;
  hasBadge: boolean;
}> = [
  { id: "free", priceMonthly: 0, priceYearlyMonthlyEquivalent: 0, highlight: false, hasBadge: false },
  { id: "creator", priceMonthly: 19, priceYearlyMonthlyEquivalent: 15.2, highlight: false, hasBadge: false },
  { id: "pro", priceMonthly: 39, priceYearlyMonthlyEquivalent: 31.2, highlight: true, hasBadge: true },
  { id: "business", priceMonthly: 99, priceYearlyMonthlyEquivalent: 79.2, highlight: false, hasBadge: false },
];

function formatMonthly(n: number) {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export default function PricingPage() {
  const t = useTranslations();
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const faq = t.raw("pricing.faq") as Array<{ q: string; a: string }>;

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
          <a href="/features" className="hover:text-white transition-colors">{t("nav.features")}</a>
          <LanguageSwitcher />
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            {t("nav.getStarted")}
          </a>
        </div>
      </nav>

      <div className="max-w-[1100px] mx-auto px-6 py-16">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#00d1ff" }} />
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>{t("pricing.badge")}</span>
          </div>
          <h1 className="font-headline font-extrabold mb-3"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#e1e2eb", lineHeight: 1.1 }}>
            {t("pricing.title")}
          </h1>
          <p style={{ color: "#859399", maxWidth: 520, margin: "0 auto" }}>
            {t("pricing.subtitle")}
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
              {t("pricing.cycle.monthly")}
            </button>
            <button
              onClick={() => setCycle("yearly")}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-2"
              style={{
                background: cycle === "yearly" ? "linear-gradient(135deg, #00d1ff, #6d11ad)" : "transparent",
                color: cycle === "yearly" ? "white" : "#859399",
              }}
            >
              {t("pricing.cycle.yearly")}
              <span className="px-1.5 py-0.5 text-[10px] rounded-md font-bold"
                style={{
                  background: cycle === "yearly" ? "rgba(255,255,255,0.2)" : "rgba(52,211,153,0.15)",
                  color: cycle === "yearly" ? "white" : "#34d399",
                }}>
                {t("pricing.cycle.save")}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {PLANS.map((plan) => {
            const features = t.raw(`pricing.plans.${plan.id}.features`) as string[];
            const displayPrice =
              plan.priceMonthly === 0
                ? "$0"
                : cycle === "yearly"
                  ? formatMonthly(plan.priceYearlyMonthlyEquivalent)
                  : formatMonthly(plan.priceMonthly);
            const displayPeriod =
              plan.priceMonthly === 0
                ? t("pricing.period.forever")
                : cycle === "yearly"
                  ? t("pricing.period.monthBilledYearly")
                  : t("pricing.period.month");
            return (
              <div key={plan.id} className="relative flex flex-col p-6 rounded-2xl"
                style={{
                  background: plan.highlight ? "rgba(0,209,255,0.05)" : "rgba(29,32,38,0.7)",
                  border: plan.highlight ? "1.5px solid rgba(0,209,255,0.3)" : "1px solid rgba(255,255,255,0.05)",
                  boxShadow: plan.highlight ? "0 0 40px rgba(0,209,255,0.07)" : "none",
                }}>
                {plan.hasBadge && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-bold text-white whitespace-nowrap"
                    style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
                    {t("pricing.mostPopular")}
                  </span>
                )}
                <div className="mb-5">
                  <p className="font-headline font-semibold mb-1 text-sm" style={{ color: "#e1e2eb" }}>
                    {t(`pricing.plans.${plan.id}.name`)}
                  </p>
                  <div className="flex items-baseline gap-1 mb-2">
                    <span className="font-headline font-black text-3xl"
                      style={{ color: plan.highlight ? "#00d1ff" : "#e1e2eb" }}>{displayPrice}</span>
                    <span className="text-xs" style={{ color: "#859399" }}>{displayPeriod}</span>
                  </div>
                  <p className="text-xs" style={{ color: "#859399" }}>
                    {t(`pricing.plans.${plan.id}.desc`)}
                  </p>
                </div>

                <ul className="space-y-2.5 mb-7 flex-1">
                  {features.map((f) => (
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
                  {t(`pricing.plans.${plan.id}.cta`)}
                </a>
              </div>
            );
          })}
        </div>

        {/* Enterprise strip */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 p-6 rounded-2xl"
          style={{ background: "rgba(109,17,173,0.05)", border: "1px solid rgba(109,17,173,0.25)" }}>
          <div>
            <p className="font-headline font-semibold text-sm mb-1" style={{ color: "#e1e2eb" }}>
              {t("pricing.enterprise.title")}
            </p>
            <p className="text-xs" style={{ color: "#859399" }}>
              {t("pricing.enterprise.desc")}
            </p>
          </div>
          <a href="mailto:founder@braavolabs.com" className="px-5 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap"
            style={{ background: "rgba(255,255,255,0.06)", color: "#e1e2eb", border: "1px solid rgba(255,255,255,0.08)", textDecoration: "none" }}>
            {t("pricing.enterprise.cta")}
          </a>
        </div>

        {/* FAQ strip */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-4">
          {faq.map((item) => (
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
