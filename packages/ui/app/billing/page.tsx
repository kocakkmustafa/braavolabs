"use client";

import { useEffect, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { PLAN_LIMITS as SHARED_PLAN_LIMITS, PLAN_LABEL, PLAN_PRICING } from "@ai-company-os/core";

// Display-friendly summary per plan — pulled from the shared 5-tier source of
// truth in @ai-company-os/core so /pricing, /settings, /billing all stay in sync.
// Previously this file hardcoded only 3 tiers (FREE/PRO/ENTERPRISE) at $49 while
// /pricing advertised 5 tiers ($19/$39/$99) — that mismatch caused a bait-and-
// switch perception. One source now feeds all consumers.
const PLAN_LIMITS: Record<string, { runs: number; companies: number; channels: string; connectedAutomations: number }> =
  Object.fromEntries(
    (Object.keys(SHARED_PLAN_LIMITS) as Array<keyof typeof SHARED_PLAN_LIMITS>).map((plan) => {
      const l = SHARED_PLAN_LIMITS[plan];
      const channelSummary = l.channels.length >= 7 ? "All + custom"
        : l.channels.length >= 5 ? "All channels"
        : `${l.channels.length} channels`;
      return [plan, { runs: l.maxRunsPerMonth, companies: l.maxCompanies, channels: channelSummary, connectedAutomations: l.maxConnectedAutomations }];
    })
  );

// Animate a progress bar from 0 → target width on mount
function UsageBar({ pct, warn }: { pct: number; warn: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      if (barRef.current) barRef.current.style.width = `${pct}%`;
    }, 200);
    return () => clearTimeout(t);
  }, [pct]);
  return (
    <div className="h-[10px] rounded-[6px] overflow-hidden border border-outline-variant" style={{ background: "var(--color-surface-container-lowest)" }}>
      <div
        ref={barRef}
        className="h-full rounded-[6px] transition-[width] duration-[1000ms]"
        style={{
          width: "0%",
          background: warn
            ? "linear-gradient(90deg, var(--bv-status-running), var(--bv-status-failed))"
            : "linear-gradient(90deg, var(--color-primary), var(--color-secondary))",
        }}
      />
    </div>
  );
}

export default function BillingPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [usage, setUsage] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    Promise.all([
      api.billingUsage(token).catch(() => null),
      api.billingSubscription(token).catch(() => null),
    ]).then(([u, s]) => {
      setUsage(u);
      setSubscription(s);
      setLoading(false);
    });
  }, [token, hydrated]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin border-primary/30" style={{ borderTopColor: "var(--color-primary)" }} />
    </div>
  );

  const plan = usage?.plan ?? "FREE";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.FREE;

  async function handleUpgrade(target: "PRO" | "ENTERPRISE") {
    setUpgradeLoading(true);
    setErrorMsg(null);
    try {
      const { url } = await api.billingCheckout(token!, target);
      window.location.href = url;
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
    setUpgradeLoading(false);
  }

  async function handlePortal() {
    setErrorMsg(null);
    try {
      const { url } = await api.billingPortal(token!);
      window.location.href = url;
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">

      {/* Page head */}
      <div className="bv-page-head mb-6">
        <div>
          <p className="bv-micro text-on-surface-variant mb-1">Account</p>
          <h1 className="bv-display gradient-text">{t("app.billing.title")}</h1>
          <p className="bv-caption mt-1">{t("app.billing.subtitle")}</p>
        </div>
      </div>

      {/* Error banner */}
      {errorMsg && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl mb-4 text-sm border border-error/20 bg-error/10 text-error">
          <span className="material-symbols-outlined text-base">error</span>
          <span className="flex-1">{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="bv-btn bv-btn-sm bv-btn-ghost">
            {t("app.billing.dismiss")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bv-glass rounded-2xl h-24 animate-shimmer" />
          ))}
        </div>
      ) : (
        <div className="bv-stagger">

          {/* ── Top 2-col grid: plan card + manage subscription ── */}
          <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-[18px] mb-[18px]">

            {/* Current plan card */}
            <div className="bv-glass p-[26px]">
              {/* Row 1: tier name + active badge */}
              <div className="flex items-center gap-3 mb-[14px]">
                <span className="bv-display uppercase tracking-tight text-on-surface">
                  {PLAN_LABEL?.[plan as keyof typeof PLAN_LABEL] ?? plan}
                </span>
                <span className="bv-pill bv-pill-cyan">Active</span>
              </div>

              {/* Price */}
              <div className="flex items-baseline gap-1 mb-[6px]">
                <span className="bv-headline text-on-surface">
                  {PLAN_PRICING[plan as keyof typeof PLAN_PRICING]?.monthlyUsd
                    ? `$${PLAN_PRICING[plan as keyof typeof PLAN_PRICING].monthlyUsd}`
                    : t("app.billing.planEnterprisePrice")}
                </span>
                <span className="bv-caption">/ month</span>
              </div>

              {/* Renew date */}
              {subscription?.subscription && (
                <p className="bv-mono text-on-surface-variant mb-[20px]">
                  {subscription.subscription.cancelAtPeriodEnd ? t("app.billing.cancels") : t("app.billing.renews")}{" "}
                  {new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()} · via Stripe
                </p>
              )}

              {/* Runs remaining trial strip */}
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-[11px] mt-5"
                style={{
                  border: "1px solid rgba(var(--bv-status-running, 255,122,26), 0.35)",
                  background: "rgba(255,122,26,0.06)",
                }}
              >
                <span className="bv-dot bv-running bv-ping flex-shrink-0" />
                <div className="flex items-baseline gap-2">
                  <span className="bv-headline" style={{ color: "var(--bv-status-running)" }}>
                    {limits.runs < 0 ? "∞" : limits.runs - (usage?.live?.runs ?? 0)}
                  </span>
                  <span className="bv-caption">runs remaining on {PLAN_LABEL?.[plan as keyof typeof PLAN_LABEL] ?? plan}</span>
                </div>
              </div>
            </div>

            {/* Manage subscription card */}
            <div className="bv-glass p-[22px] flex flex-col gap-2">
              <p className="bv-micro mb-2">Manage subscription</p>
              <p className="bv-caption leading-relaxed mb-2">
                Web plans bill through Stripe — manage, upgrade or cancel anytime in the billing portal. Mobile subscriptions are managed in the store you subscribed through; changes sync here automatically.
              </p>

              {/* Stripe (web) row */}
              <div
                className="flex items-center gap-3 py-[10px] border-b"
                style={{ borderColor: "var(--color-outline-variant)" }}
              >
                <div
                  className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center flex-shrink-0 border"
                  style={{ background: "var(--color-surface-container)", borderColor: "var(--bv-steel-highlight)" }}
                >
                  <span className="material-symbols-outlined text-sm text-on-surface-variant">credit_card</span>
                </div>
                <span className="bv-body text-on-surface flex-1">Stripe subscription</span>
                {subscription?.stripeCustomerId ? (
                  <button onClick={handlePortal} className="bv-btn bv-btn-sm bv-btn-primary">
                    Manage
                    <span className="material-symbols-outlined text-sm">arrow_forward</span>
                  </button>
                ) : (
                  <span className="bv-caption text-on-surface-variant">Not active</span>
                )}
              </div>

              {/* App Store row */}
              <div
                className="flex items-center gap-3 py-[10px] border-b"
                style={{ borderColor: "var(--color-outline-variant)" }}
              >
                <div
                  className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center flex-shrink-0 border"
                  style={{ background: "var(--color-surface-container)", borderColor: "var(--bv-steel-highlight)" }}
                >
                  <span className="material-symbols-outlined text-sm text-on-surface-variant">apple</span>
                </div>
                <span className="bv-body text-on-surface flex-1">App Store subscription</span>
                <span className="bv-caption text-on-surface-variant">Managed in store</span>
              </div>

              {/* Google Play row */}
              <div className="flex items-center gap-3 py-[10px]">
                <div
                  className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center flex-shrink-0 border"
                  style={{ background: "var(--color-surface-container)", borderColor: "var(--bv-steel-highlight)" }}
                >
                  <span className="material-symbols-outlined text-sm text-on-surface-variant">play_arrow</span>
                </div>
                <span className="bv-body text-on-surface flex-1">Google Play subscription</span>
                <span className="bv-caption text-on-surface-variant">Managed in store</span>
              </div>
            </div>
          </div>

          {/* ── Usage meters ── */}
          <div className="bv-glass mb-[18px]">
            <div className="p-6 pb-0 flex items-center justify-between">
              <h2 className="bv-title uppercase tracking-wider">Usage this cycle</h2>
            </div>
            <div className="p-6 flex flex-col gap-[18px]">
              {[
                { label: t("app.billing.meterRuns"), current: usage?.live?.runs ?? 0, limit: limits.runs, icon: "play_circle" },
                { label: "Workspaces", current: usage?.live?.workspaces ?? 0, limit: limits.companies, icon: "workspaces" },
                { label: t("app.billing.meterConnections"), current: usage?.live?.connections ?? 0, limit: limits.connectedAutomations, icon: "lan" },
                { label: t("app.billing.meterToolCalls"), current: usage?.live?.toolCalls ?? 0, limit: -1, icon: "build" },
              ].map((m) => {
                const unlimited = m.limit < 0;
                const pct = unlimited ? 38 : Math.min(100, (m.current / m.limit) * 100);
                const warn = !unlimited && pct >= 80;
                return (
                  <div key={m.label}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-base text-on-surface-variant">{m.icon}</span>
                        <span className="bv-body text-on-surface">{m.label}</span>
                      </div>
                      <span className="bv-mono text-on-surface-variant">
                        {unlimited
                          ? `unlimited on ${PLAN_LABEL?.[plan as keyof typeof PLAN_LABEL] ?? plan}`
                          : `${m.current} / ${m.limit}`}
                      </span>
                    </div>
                    <UsageBar pct={pct} warn={warn} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Plans comparison ── */}
          <h2 className="bv-title uppercase tracking-wider mb-4">{t("app.billing.comparePlans")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6 stagger-children">
            {[
              {
                name: t("app.billing.planFreeName"), price: `$${PLAN_PRICING.FREE.monthlyUsd}`, priceNote: t("app.billing.planFreeNote"), id: "FREE",
                features: ["1 company", "10 runs/month", "TikTok + LinkedIn", "Community support", "Basic analytics"],
              },
              {
                name: t("app.billing.planCreatorName"), price: `$${PLAN_PRICING.CREATOR.monthlyUsd}`, priceNote: t("app.billing.planMonthlyNote"), id: "CREATOR",
                features: ["5 companies", "100 runs/month", "5 channels", "Email support", "Basic analytics"],
              },
              {
                name: t("app.billing.planProName"), price: `$${PLAN_PRICING.PRO.monthlyUsd}`, priceNote: t("app.billing.planMonthlyNote"), id: "PRO", popular: true,
                features: ["15 companies", "500 runs/month", "All channels", "CRM sync (HubSpot)", "Priority support", "Blueprint sharing", "Advanced analytics"],
              },
              {
                name: t("app.billing.planBusinessName"), price: `$${PLAN_PRICING.BUSINESS.monthlyUsd}`, priceNote: t("app.billing.planMonthlyNote"), id: "BUSINESS",
                features: ["50 companies", "2,000 runs/month", "All channels + custom", "Webhooks", "Dedicated support", "Approval workflows", "Audit log export"],
              },
              {
                name: t("app.billing.planEnterpriseName"), price: t("app.billing.planEnterprisePrice"), priceNote: t("app.billing.planEnterpriseNote"), id: "ENTERPRISE",
                features: ["Unlimited everything", "SSO / SAML", "Dedicated SLA", "Custom integrations", "White-label option", "On-premise deployment"],
              },
            ].map((p) => (
              <div
                key={p.id}
                className="bv-glass p-6 flex flex-col relative overflow-hidden"
                style={plan === p.id ? { borderColor: "rgba(96,165,250,0.4)" } : undefined}
              >
                {(p as any).popular && plan !== p.id && (
                  <div className="absolute top-0 right-0 px-3 py-1 bv-micro rounded-bl-xl bv-btn-primary" style={{ borderRadius: "0 20px 0 12px" }}>
                    {t("app.billing.popular")}
                  </div>
                )}
                <p className="bv-title mb-1">{p.name}</p>
                <div className="mb-4 flex items-baseline gap-1">
                  <span className="bv-headline gradient-text">{p.price}</span>
                  <span className="bv-caption">{p.priceNote}</span>
                </div>
                {plan === p.id && (
                  <span className="bv-pill bv-pill-cyan self-start mb-3">
                    {t("app.billing.currentPlan")}
                  </span>
                )}
                <ul className="flex flex-col gap-2 mb-6 flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 bv-caption">
                      <span className="material-symbols-outlined flex-shrink-0 text-primary" style={{ fontSize: 14, marginTop: 1 }}>check</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {plan !== p.id && p.id !== "FREE" && (
                  <button
                    onClick={() => handleUpgrade(p.id as "PRO" | "ENTERPRISE")}
                    disabled={upgradeLoading}
                    className="bv-btn bv-btn-primary w-full justify-center disabled:opacity-50"
                  >
                    {upgradeLoading ? t("app.billing.processing") : t("app.billing.upgradeTo", { name: p.name })}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* ── Invoices table ── */}
          {usage?.meters && usage.meters.length > 0 && (
            <>
              <h2 className="bv-title uppercase tracking-wider mb-4">{t("app.billing.usageHistory")}</h2>
              <div className="bv-glass overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--color-outline-variant)" }}>
                        <th className="text-left px-[18px] py-[13px] bv-micro text-on-surface-variant font-medium">{t("app.billing.thMetric")}</th>
                        <th className="text-right px-[18px] py-[13px] bv-micro text-on-surface-variant font-medium">{t("app.billing.thValue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.meters.map((m: any, i: number) => (
                        <tr
                          key={i}
                          className="interactive-row"
                          style={{ borderBottom: "1px solid rgba(35,40,51,0.6)" }}
                        >
                          <td className="px-[18px] py-[13px] bv-body text-on-surface-variant">{m.metric}</td>
                          <td className="px-[18px] py-[13px] text-right bv-mono text-on-surface">{m.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
