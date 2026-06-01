"use client";

import { useEffect, useState } from "react";
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
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
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
      <div className="mb-8">
        <h1 className="text-xl sm:text-2xl font-bold font-headline gradient-text">{t("app.billing.title")}</h1>
        <p className="text-sm mt-0.5" style={{ color: "#859399" }}>{t("app.billing.subtitle")}</p>
      </div>

      {errorMsg && (
        <div className="px-4 py-3 rounded-xl mb-4 text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
          {errorMsg}
          <button onClick={() => setErrorMsg(null)} className="ml-3 underline text-xs" style={{ color: "#f87171" }}>{t("app.billing.dismiss")}</button>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card rounded-xl h-24 animate-shimmer" />
          ))}
        </div>
      ) : (
        <>
          {/* Current plan banner */}
          <div className="glass-card rounded-2xl p-6 mb-4" style={{ borderLeft: "3px solid #00d1ff" }}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: plan === "PRO" ? "rgba(109,17,173,0.15)" : "rgba(0,209,255,0.08)", border: `1px solid ${plan === "PRO" ? "rgba(109,17,173,0.3)" : "rgba(0,209,255,0.2)"}` }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 24, color: plan === "PRO" ? "#e0b6ff" : "#00d1ff" }}>
                    {plan === "ENTERPRISE" ? "diamond" : plan === "PRO" ? "workspace_premium" : "rocket_launch"}
                  </span>
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="font-headline font-bold text-lg" style={{ color: "#e1e2eb" }}>{plan} {t("app.billing.planSuffix")}</h2>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399" }}>{t("app.billing.active")}</span>
                  </div>
                  {subscription?.subscription && (
                    <p className="text-xs mt-1" style={{ color: "#859399" }}>
                      {subscription.subscription.cancelAtPeriodEnd ? t("app.billing.cancels") : t("app.billing.renews")}{" "}
                      {new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
              {subscription?.stripeCustomerId && (
                <button
                  onClick={handlePortal}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>credit_card</span>
                  {t("app.billing.manageBilling")}
                </button>
              )}
            </div>
          </div>

          {/* Usage meters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 stagger-children">
            {[
              { label: t("app.billing.meterRuns"), current: usage?.live?.runs ?? 0, limit: limits.runs, icon: "play_circle", color: "#00d1ff" },
              { label: t("app.billing.meterToolCalls"), current: usage?.live?.toolCalls ?? 0, limit: -1, icon: "build", color: "#a4e6ff" },
              { label: t("app.billing.meterCompanies"), current: 0, limit: limits.companies, icon: "business", color: "#34d399" },
              { label: t("app.billing.meterConnections"), current: 0, limit: limits.connectedAutomations, icon: "lan", color: "#e0b6ff" },
              { label: t("app.billing.meterChannels"), current: 0, limit: -1, icon: "hub", color: "#fbbf24", text: limits.channels },
            ].map((m) => {
              const unlimited = m.limit < 0;
              const pct = unlimited ? 0 : Math.min(100, (m.current / m.limit) * 100);
              const danger = !unlimited && pct >= 80;
              return (
                <div key={m.label} className="metric-card rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="material-symbols-outlined" style={{ fontSize: 16, color: m.color }}>{m.icon}</span>
                    <span className="text-xs" style={{ color: "#859399" }}>{m.label}</span>
                  </div>
                  {m.text ? (
                    <p className="font-semibold text-sm" style={{ color: "#e1e2eb" }}>{m.text}</p>
                  ) : (
                    <>
                      <p className="font-headline font-bold text-xl mb-2" style={{ color: danger ? "#f87171" : "#e1e2eb" }}>
                        {m.current}{!unlimited && <span className="text-sm font-normal" style={{ color: "#3c494e" }}> / {m.limit}</span>}
                      </p>
                      {!unlimited && (
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: danger ? "#f87171" : `linear-gradient(90deg, ${m.color}, #6d11ad)` }} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Plans comparison — pricing pulled from PLAN_PRICING (single
              source of truth in @ai-company-os/core) so /pricing, /billing,
              the mobile paywall, and the StoreKit/Play Billing catalog all
              stay in lockstep. Previously hardcoded $49 for Pro while the
              marketing page advertised $39 — bait-and-switch fixed. */}
          <h2 className="font-headline font-bold text-base mb-4" style={{ color: "#e1e2eb" }}>{t("app.billing.comparePlans")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
            {[
              {
                name: t("app.billing.planFreeName"), price: `$${PLAN_PRICING.FREE.monthlyUsd}`, priceNote: t("app.billing.planFreeNote"), id: "FREE", color: "#859399",
                features: ["1 company", "10 runs/month", "TikTok + LinkedIn", "Community support", "Basic analytics"],
              },
              {
                name: t("app.billing.planCreatorName"), price: `$${PLAN_PRICING.CREATOR.monthlyUsd}`, priceNote: t("app.billing.planMonthlyNote"), id: "CREATOR", color: "#a4e6ff",
                features: ["5 companies", "100 runs/month", "5 channels", "Email support", "Basic analytics"],
              },
              {
                name: t("app.billing.planProName"), price: `$${PLAN_PRICING.PRO.monthlyUsd}`, priceNote: t("app.billing.planMonthlyNote"), id: "PRO", color: "#00d1ff", popular: true,
                features: ["15 companies", "500 runs/month", "All channels", "CRM sync (HubSpot)", "Priority support", "Blueprint sharing", "Advanced analytics"],
              },
              {
                name: t("app.billing.planBusinessName"), price: `$${PLAN_PRICING.BUSINESS.monthlyUsd}`, priceNote: t("app.billing.planMonthlyNote"), id: "BUSINESS", color: "#d4b6f5",
                features: ["50 companies", "2,000 runs/month", "All channels + custom", "Webhooks", "Dedicated support", "Approval workflows", "Audit log export"],
              },
              {
                name: t("app.billing.planEnterpriseName"), price: t("app.billing.planEnterprisePrice"), priceNote: t("app.billing.planEnterpriseNote"), id: "ENTERPRISE", color: "#e0b6ff",
                features: ["Unlimited everything", "SSO / SAML", "Dedicated SLA", "Custom integrations", "White-label option", "On-premise deployment"],
              },
            ].map((p) => (
              <div
                key={p.id}
                className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden"
                style={{ border: plan === p.id ? "1.5px solid rgba(0,209,255,0.4)" : "1.5px solid rgba(255,255,255,0.06)" }}
              >
                {(p as any).popular && plan !== p.id && (
                  <div
                    className="absolute top-0 right-0 px-3 py-1 text-[10px] font-bold rounded-bl-xl"
                    style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white" }}
                  >
                    {t("app.billing.popular")}
                  </div>
                )}
                <p className="font-headline font-bold text-base mb-1" style={{ color: "#e1e2eb" }}>{p.name}</p>
                <div className="mb-4">
                  <span className="font-headline font-bold text-2xl" style={{ color: p.color }}>{p.price}</span>
                  <span className="text-xs ml-1" style={{ color: "#3c494e" }}>{p.priceNote}</span>
                </div>
                {plan === p.id && (
                  <span className="inline-block mb-3 px-2.5 py-0.5 rounded-full text-[10px] font-bold self-start" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" }}>
                    {t("app.billing.currentPlan")}
                  </span>
                )}
                <ul className="space-y-2 mb-6 flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs" style={{ color: "#bbc9cf" }}>
                      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 14, color: p.color, marginTop: 1 }}>check</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {plan !== p.id && p.id !== "FREE" && (
                  <button
                    onClick={() => handleUpgrade(p.id as "PRO" | "ENTERPRISE")}
                    disabled={upgradeLoading}
                    className="w-full py-2.5 rounded-xl text-sm font-bold transition-all hover:brightness-110 disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white" }}
                  >
                    {upgradeLoading ? t("app.billing.processing") : t("app.billing.upgradeTo", { name: p.name })}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Usage history */}
          {usage?.meters && usage.meters.length > 0 && (
            <>
              <h2 className="font-headline font-bold text-base mb-4" style={{ color: "#e1e2eb" }}>{t("app.billing.usageHistory")}</h2>
              <div className="glass-card rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: "#859399" }}>{t("app.billing.thMetric")}</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold" style={{ color: "#859399" }}>{t("app.billing.thValue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.meters.map((m: any, i: number) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <td className="px-4 py-3" style={{ color: "#bbc9cf" }}>{m.metric}</td>
                          <td className="px-4 py-3 text-right font-mono font-semibold" style={{ color: "#e1e2eb" }}>{m.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
