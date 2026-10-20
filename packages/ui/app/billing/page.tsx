"use client";
import { useLocalizedFailure } from "../../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useLocale as useDisplayLocale } from "next-intl";
import { formatDateTime as formatDisplayDateTime, currentTimeZone as displayTimeZone } from "../../i18n/locales";

import { useTranslations as useLegacyTranslations } from "next-intl";


import { useEffect, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import {
  PLAN_LIMITS as SHARED_PLAN_LIMITS,
  PLAN_LABEL,
  PLAN_PRICING,
  normalizePlanForEntitlement,
} from "@ai-company-os/core";

// Display-friendly compatibility summary. Checkout cards below enumerate only
// PLAN_ORDER's two canonical new-sale plans.
const PLAN_LIMITS: Record<string, { runs: number; companies: number; channels: number; connectedAutomations: number }> =
  Object.fromEntries(
    (Object.keys(SHARED_PLAN_LIMITS) as Array<keyof typeof SHARED_PLAN_LIMITS>).map((plan) => {
      const l = SHARED_PLAN_LIMITS[plan];
      return [plan, { runs: l.maxRunsPerMonth, companies: l.maxCompanies, channels: l.channels.length, connectedAutomations: l.maxConnectedAutomations }];
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
  const describeFailure = useLocalizedFailure();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const displayLocale = useDisplayLocale();
  const uiText = useLegacyTranslations("uiCopy");
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

  const plan = normalizePlanForEntitlement(usage?.plan);
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.MANUAL_REVIEW;

  async function handleUpgrade(target: "INDIVIDUAL" | "TEAM") {
    setUpgradeLoading(true);
    setErrorMsg(null);
    try {
      const { url } = await api.billingCheckout(token!, target);
      window.location.href = url;
    } catch (err) {
      setErrorMsg(describeFailure(err));
    }
    setUpgradeLoading(false);
  }

  async function handlePortal() {
    setErrorMsg(null);
    try {
      const { url } = await api.billingPortal(token!);
      window.location.href = url;
    } catch (err) {
      setErrorMsg(describeFailure(err));
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">

      {/* Page head */}
      <div className="bv-page-head mb-6">
        <div>
          <p className="bv-micro text-on-surface-variant mb-1">{uiText("mcc7dbaccf493")}</p>
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
                <span className="bv-pill bv-pill-cyan">{uiText("m3ed9a01e9231")}</span>
              </div>

              {/* Price */}
              <div className="flex items-baseline gap-1 mb-[6px]">
                <span className="bv-headline text-on-surface">
                  {PLAN_PRICING[plan as keyof typeof PLAN_PRICING]?.monthlyUsd
                    ? `$${PLAN_PRICING[plan as keyof typeof PLAN_PRICING].monthlyUsd}`
                    :uiText("m1f1c52f4af63")}
                </span>
                {plan !== "MANUAL_REVIEW" && (
                  <span className="bv-caption">
                    {plan === "TEAM" ?uiText("m10a01ee78fc0") :uiText("m36319a66e749")}
                  </span>
                )}
              </div>

              {/* Renew date */}
              {subscription?.subscription && (
                <p className="bv-mono text-on-surface-variant mb-[20px]">
                  {subscription.subscription.cancelAtPeriodEnd ? t("app.billing.cancels") : t("app.billing.renews")}{" "}
                  {formatDisplayDateTime(subscription.subscription.currentPeriodEnd, displayLocale, { timeZone: displayTimeZone(), dateStyle: "medium" })}{" "}{uiText("m2abded1f04d2")}</p>
              )}

              {/* Operational run telemetry; not an inference entitlement. */}
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
                  <span className="bv-caption">{uiText("m52ef97127549")}{" "}{PLAN_LABEL?.[plan as keyof typeof PLAN_LABEL] ?? plan}</span>
                </div>
              </div>
            </div>

            {/* Manage subscription card */}
            <div className="bv-glass p-[22px] flex flex-col gap-2">
              <p className="bv-micro mb-2">{uiText("m3aacf07b35fc")}</p>
              <p className="bv-caption leading-relaxed mb-2">{uiText("m480aee3b6717")}</p>

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
                <span className="bv-body text-on-surface flex-1">{uiText("mc55a17a9d9c0")}</span>
                {subscription?.stripeCustomerId ? (
                  <button onClick={handlePortal} className="bv-btn bv-btn-sm bv-btn-primary">{uiText("mcceb0b8f209d")}<span className="material-symbols-outlined text-sm">arrow_forward</span>
                  </button>
                ) : (
                  <span className="bv-caption text-on-surface-variant">{uiText("m03899b81220f")}</span>
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
                <span className="bv-body text-on-surface flex-1">{uiText("m659adfa80ad7")}</span>
                <span className="bv-caption text-on-surface-variant">{uiText("mcd435f3d6d13")}</span>
              </div>

              {/* Google Play row */}
              <div className="flex items-center gap-3 py-[10px]">
                <div
                  className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center flex-shrink-0 border"
                  style={{ background: "var(--color-surface-container)", borderColor: "var(--bv-steel-highlight)" }}
                >
                  <span className="material-symbols-outlined text-sm text-on-surface-variant">play_arrow</span>
                </div>
                <span className="bv-body text-on-surface flex-1">{uiText("mf1b895df0335")}</span>
                <span className="bv-caption text-on-surface-variant">{uiText("mcd435f3d6d13")}</span>
              </div>
            </div>
          </div>

          {/* ── Usage meters ── */}
          <div className="bv-glass mb-[18px]">
            <div className="p-6 pb-0 flex items-center justify-between">
              <h2 className="bv-title uppercase tracking-wider">{uiText("m8546b709215e")}</h2>
            </div>
            <div className="p-6 flex flex-col gap-[18px]">
              {[
                { label: t("app.billing.meterRuns"), current: usage?.live?.runs ?? 0, limit: limits.runs, icon: "play_circle" },
                { label: runtimeCopy("m9f9acdbf39bc"), current: usage?.live?.workspaces ?? 0, limit: limits.companies, icon: "workspaces" },
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
                          ? runtimeCopy("m3800b6e67ce8", { value0: PLAN_LABEL?.[plan as keyof typeof PLAN_LABEL] ?? plan })
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 stagger-children">
            {[
              {
                name: PLAN_LABEL.INDIVIDUAL,
                price: `$${PLAN_PRICING.INDIVIDUAL.monthlyUsd}`,
                priceNote: runtimeCopy("mdd0763b9fc75"),
                id: "INDIVIDUAL",
                features: [runtimeCopy("m8502572a269d"), runtimeCopy("m8779b63b388b"), runtimeCopy("m739f35478664"), runtimeCopy("m4d03ba19634f"), runtimeCopy("m7ab3157462b0")],
              },
              {
                name: PLAN_LABEL.TEAM,
                price: `$${PLAN_PRICING.TEAM.monthlyUsd}`,
                priceNote: runtimeCopy("m6c35c098be76"),
                id: "TEAM",
                popular: true,
                features: [runtimeCopy("ma8499c1fc913"), runtimeCopy("m8779b63b388b"), runtimeCopy("m739f35478664"), runtimeCopy("m5ad4deeaabd5"), runtimeCopy("m3fcd392b558f")],
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
                {plan !== p.id && (
                  <button
                    onClick={() => handleUpgrade(p.id as "INDIVIDUAL" | "TEAM")}
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
