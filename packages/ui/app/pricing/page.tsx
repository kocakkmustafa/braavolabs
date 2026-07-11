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

const FEATURE_MATRIX = [
  { label: "Workspaces",                       free: "1",    creator: "3",    pro: "10",   business: "∞" },
  { label: "Runs",                              free: "trial", creator: "∞",  pro: "∞",    business: "∞" },
  { label: "Connected automations (n8n · Make · Zapier)", free: false, creator: "5", pro: "20", business: "∞" },
  { label: "Team seats",                        free: "1",    creator: "1",    pro: "5",    business: "∞" },
  { label: "BYOK · 14 providers",              free: true,   creator: true,   pro: true,   business: true },
  { label: "On-device Gemma (offline)",         free: false,  creator: false,  pro: true,   business: true },
  { label: "Mobile pocket-steer",              free: true,   creator: true,   pro: true,   business: true },
  { label: "5 risk-stops & full audit trail",  free: true,   creator: true,   pro: true,   business: true },
  { label: "Encrypted offline export bundle",  free: false,  creator: false,  pro: true,   business: true },
];

function formatMonthly(n: number) {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

type MatrixCell = boolean | string;

function MatrixCell({ value, isHighlight }: { value: MatrixCell; isHighlight: boolean }) {
  if (value === true) {
    return (
      <span className="material-symbols-outlined" style={{ color: isHighlight ? "#60A5FA" : "#3B82F6", fontSize: 18 }}>
        check_circle
      </span>
    );
  }
  if (value === false) {
    return <span style={{ color: "var(--color-outline)" }}>—</span>;
  }
  if (value === "trial" || value === "3 trial") {
    return <span style={{ color: "#FF7A1A", fontFamily: "var(--bv-font-mono)", fontSize: 13 }}>3 trial</span>;
  }
  return (
    <span style={{ color: isHighlight ? "#60A5FA" : "var(--color-on-surface)", fontWeight: value === "∞" ? 600 : 400 }}>
      {value}
    </span>
  );
}

export default function PricingPage() {
  const t = useTranslations();
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const faq = t.raw("pricing.faq") as Array<{ q: string; a: string }>;

  return (
    <div className="min-h-screen bv-mesh">
      {/* Nav */}
      <nav
        className="sticky top-0 z-50"
        style={{
          background: "rgba(6,7,10,0.80)",
          backdropFilter: "blur(20px) saturate(1.2)",
          WebkitBackdropFilter: "blur(20px) saturate(1.2)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <div className="max-w-[1100px] mx-auto px-6 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center bv-btn-primary"
              style={{ padding: 0, minHeight: "unset" }}
            >
              <span className="font-headline font-bold text-xs text-white">B</span>
            </div>
            <span className="font-headline font-semibold text-sm text-on-surface">Braavolabs</span>
          </a>

          <div className="hidden md:flex items-center gap-6 text-sm" style={{ color: "var(--color-on-surface-variant)" }}>
            <a href="/features" className="hover:text-on-surface transition-colors">{t("nav.features")}</a>
            <a href="/pricing" className="text-primary font-medium">{t("nav.pricing") ?? "Pricing"}</a>
            <LanguageSwitcher />
          </div>

          <div className="flex items-center gap-3">
            <a href="/login" className="bv-btn bv-btn-ghost bv-btn-sm hidden sm:inline-flex">
              {t("nav.signIn") ?? "Sign in"}
            </a>
            <a href="/register" className="bv-btn bv-btn-primary bv-btn-sm bv-sheen">
              {t("nav.getStarted")}
            </a>
          </div>
        </div>
      </nav>

      <main>
        {/* ── Page head ─────────────────────────────────────── */}
        <section className="text-center px-6 pt-20 pb-4">
          <div className="max-w-[1100px] mx-auto">
            {/* Eyebrow */}
            <div className="inline-flex items-center gap-2 mb-5 bv-pill bv-pill-cyan">
              <span className="bv-dot bv-running bv-ping" />
              {t("pricing.badge") ?? "Pricing"}
            </div>

            <h1
              className="font-headline font-semibold uppercase mb-4"
              style={{
                fontSize: "clamp(38px, 6vw, 72px)",
                lineHeight: 0.95,
                letterSpacing: "-0.02em",
                color: "var(--color-on-surface)",
              }}
            >
              {t("pricing.title")}
            </h1>

            <p className="mx-auto mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "52ch", fontSize: 18 }}>
              {t("pricing.subtitle")}
            </p>

            {/* Billing cycle toggle */}
            <div className="inline-flex items-center gap-1 bv-segmented">
              <button
                onClick={() => setCycle("monthly")}
                className={cycle === "monthly" ? "active" : ""}
              >
                {t("pricing.cycle.monthly")}
              </button>
              <button
                onClick={() => setCycle("yearly")}
                className={cycle === "yearly" ? "active" : ""}
              >
                {t("pricing.cycle.yearly")}
                <span
                  className="ml-2 bv-mono"
                  style={{ color: "#FF7A1A", fontSize: 11, letterSpacing: "0.04em" }}
                >
                  {t("pricing.cycle.save")}
                </span>
              </button>
            </div>
          </div>
        </section>

        {/* ── Tier cards ────────────────────────────────────── */}
        <section className="px-6 pt-14 pb-6">
          <div className="max-w-[1100px] mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 bv-stagger">
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
                <div
                  key={plan.id}
                  className="bv-glass flex flex-col"
                  style={{
                    padding: "28px 26px",
                    border: plan.highlight
                      ? "1px solid rgba(96,165,250,0.45)"
                      : "1px solid var(--bv-glass-border)",
                    boxShadow: plan.highlight
                      ? "inset 0 1px 0 rgba(255,255,255,0.05), 0 0 50px -16px rgba(59,130,246,0.5), 0 24px 50px -28px rgba(0,0,0,0.9)"
                      : undefined,
                    position: "relative",
                    overflow: plan.highlight ? "hidden" : undefined,
                  }}
                >
                  {/* Recommended sheen sweep */}
                  {plan.highlight && (
                    <div
                      aria-hidden
                      style={{
                        position: "absolute",
                        inset: 0,
                        pointerEvents: "none",
                        background: "linear-gradient(115deg, transparent 34%, rgba(125,211,252,0.10) 48%, transparent 62%)",
                        animation: "bv-sheen 5s ease-in-out infinite",
                      }}
                    />
                  )}

                  {/* Badge */}
                  {plan.hasBadge && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bv-pill bv-pill-cyan" style={{ fontSize: 10, letterSpacing: "0.12em" }}>
                        {t("pricing.mostPopular")}
                      </span>
                    </div>
                  )}

                  {/* Name row */}
                  <div className="flex items-center justify-between mb-4">
                    <span
                      className="font-headline font-semibold uppercase"
                      style={{ fontSize: 22, letterSpacing: "-0.02em", color: "var(--color-on-surface)" }}
                    >
                      {t(`pricing.plans.${plan.id}.name`)}
                    </span>
                  </div>

                  {/* Price */}
                  <div className="mb-1" style={{ lineHeight: 1 }}>
                    <span
                      className="font-headline font-semibold"
                      style={{
                        fontSize: 52,
                        color: plan.highlight ? "#60A5FA" : "var(--color-on-surface)",
                        letterSpacing: "-0.02em",
                      }}
                    >
                      {displayPrice}
                    </span>
                    <span className="ml-1 text-sm" style={{ color: "var(--color-on-surface-variant)" }}>
                      {displayPeriod}
                    </span>
                  </div>

                  {/* Desc */}
                  <p className="bv-body mb-5" style={{ color: "var(--color-on-surface-variant)", minHeight: 40 }}>
                    {t(`pricing.plans.${plan.id}.desc`)}
                  </p>

                  {/* Feature list */}
                  <ul className="flex flex-col gap-3 flex-1 mb-7">
                    {features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5" style={{ fontSize: 14, color: "var(--color-on-surface-variant)" }}>
                        <span
                          className="material-symbols-outlined flex-none"
                          style={{
                            fontSize: 16,
                            marginTop: 2,
                            color: plan.highlight ? "#60A5FA" : "var(--color-outline)",
                          }}
                        >
                          check_small
                        </span>
                        <span dangerouslySetInnerHTML={{ __html: f }} />
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  <a
                    href="/login"
                    className={`bv-btn w-full justify-center ${plan.highlight ? "bv-btn-primary bv-sheen" : "bv-btn-ghost"}`}
                    style={{ marginTop: "auto" }}
                  >
                    {t(`pricing.plans.${plan.id}.cta`)}
                  </a>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Feature matrix ────────────────────────────────── */}
        <section className="px-6 pt-16 pb-4">
          <div className="max-w-[1100px] mx-auto">
            <div className="bv-glass reveal" style={{ overflow: "hidden", padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14.5 }}>
                <thead>
                  <tr>
                    <th
                      style={{
                        padding: "16px 22px",
                        textAlign: "left",
                        borderBottom: "1px solid var(--bv-glass-border)",
                        fontFamily: "var(--bv-font-mono)",
                        fontSize: 11,
                        letterSpacing: "0.14em",
                        color: "var(--color-outline)",
                        fontWeight: 500,
                        textTransform: "uppercase",
                      }}
                    >
                      What scales
                    </th>
                    {(["free", "creator", "pro", "business"] as const).map((id) => (
                      <th
                        key={id}
                        style={{
                          padding: "16px 22px",
                          textAlign: "center",
                          borderBottom: "1px solid var(--bv-glass-border)",
                          fontFamily: "var(--bv-font-display)",
                          fontSize: 16,
                          textTransform: "uppercase",
                          color: id === "pro" ? "#60A5FA" : "var(--color-on-surface)",
                          fontWeight: 600,
                          background: id === "pro" ? "rgba(59,130,246,0.04)" : undefined,
                          letterSpacing: "-0.02em",
                        }}
                      >
                        {t(`pricing.plans.${id}.name`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FEATURE_MATRIX.map((row, i) => (
                    <tr key={row.label}>
                      <td
                        style={{
                          padding: "14px 22px",
                          borderBottom: i < FEATURE_MATRIX.length - 1 ? "1px solid rgba(35,40,51,0.5)" : undefined,
                          color: "var(--color-on-surface-variant)",
                          fontSize: 14,
                        }}
                      >
                        {row.label}
                      </td>
                      {(["free", "creator", "pro", "business"] as const).map((id) => (
                        <td
                          key={id}
                          style={{
                            padding: "14px 22px",
                            textAlign: "center",
                            borderBottom: i < FEATURE_MATRIX.length - 1 ? "1px solid rgba(35,40,51,0.5)" : undefined,
                            background: id === "pro" ? "rgba(59,130,246,0.04)" : undefined,
                          }}
                        >
                          <MatrixCell value={row[id] as MatrixCell} isHighlight={id === "pro"} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Enterprise strip ──────────────────────────────── */}
        <section className="px-6 pt-8">
          <div className="max-w-[1100px] mx-auto">
            <div
              className="bv-glass flex flex-col sm:flex-row items-center justify-between gap-6"
              style={{
                padding: "28px 30px",
                border: "1px solid rgba(37,99,235,0.25)",
                background: "rgba(37,99,235,0.04)",
              }}
            >
              <div>
                <div className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>Enterprise</div>
                <p className="font-headline font-semibold mb-1" style={{ fontSize: 18, color: "var(--color-on-surface)" }}>
                  {t("pricing.enterprise.title")}
                </p>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>
                  {t("pricing.enterprise.desc")}
                </p>
              </div>
              <a
                href="mailto:founder@braavolabs.com"
                className="bv-btn bv-btn-ghost whitespace-nowrap"
                style={{ textDecoration: "none" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>
                {t("pricing.enterprise.cta")}
              </a>
            </div>
          </div>
        </section>

        {/* ── FAQ ───────────────────────────────────────────── */}
        <section className="px-6 pt-16 pb-4">
          <div className="max-w-[780px] mx-auto">
            <h2
              className="font-headline font-semibold text-center mb-10 reveal"
              style={{ fontSize: "clamp(24px, 4vw, 36px)", color: "var(--color-on-surface)", letterSpacing: "-0.02em" }}
            >
              Questions
            </h2>

            <div className="flex flex-col gap-3">
              {faq.map((item, idx) => (
                <div
                  key={item.q}
                  className="bv-glass reveal"
                  style={{ padding: 0, overflow: "hidden" }}
                >
                  <button
                    onClick={() => setOpenFaq(openFaq === idx ? null : idx)}
                    className="w-full flex items-center gap-4 text-left"
                    style={{
                      padding: "18px 22px",
                      fontSize: 16,
                      fontWeight: 500,
                      color: "var(--color-on-surface)",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "var(--bv-font-body)",
                    }}
                    aria-expanded={openFaq === idx}
                  >
                    <span className="flex-1">{item.q}</span>
                    <span
                      className="material-symbols-outlined flex-none"
                      style={{
                        fontSize: 20,
                        color: "var(--color-outline)",
                        transform: openFaq === idx ? "rotate(45deg)" : "rotate(0deg)",
                        transition: "transform 0.3s var(--bv-ease-out)",
                      }}
                    >
                      add
                    </span>
                  </button>

                  {openFaq === idx && (
                    <div
                      className="bv-rise"
                      style={{
                        padding: "0 22px 20px",
                        color: "var(--color-on-surface-variant)",
                        fontSize: 14.5,
                        maxWidth: "64ch",
                        lineHeight: 1.65,
                      }}
                    >
                      {item.a}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Trust strip ───────────────────────────────────── */}
        <section className="px-6 pt-16 pb-20 text-center">
          <div className="max-w-[1100px] mx-auto">
            <div className="bv-divider mb-10" />
            <p
              className="bv-mono reveal"
              style={{ color: "var(--color-on-surface-variant)", letterSpacing: "0.04em", fontSize: 13 }}
            >
              Every tool call logged · every spend approved · every run audited
            </p>
            <p className="bv-caption mt-3 reveal" style={{ color: "var(--color-outline)" }}>
              Paid plans bill as in-app subscriptions via the App Store / Google Play.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
