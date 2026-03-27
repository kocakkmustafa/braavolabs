"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

const PLAN_LIMITS: Record<string, { runs: number; companies: number; channels: string }> = {
  FREE: { runs: 10, companies: 1, channels: "TikTok + LinkedIn" },
  PRO: { runs: 100, companies: 5, channels: "All channels" },
  ENTERPRISE: { runs: -1, companies: -1, channels: "All + custom" },
};

export default function BillingPage() {
  const { token, hydrated } = useAuthGuard();
  const [usage, setUsage] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [loading, setLoading] = useState(true);

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
    try {
      const { url } = await api.billingCheckout(token!, target);
      window.location.href = url;
    } catch (err) {
      alert((err as Error).message);
    }
    setUpgradeLoading(false);
  }

  async function handlePortal() {
    try {
      const { url } = await api.billingPortal(token!);
      window.location.href = url;
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-xl sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Billing & Usage</h1>
        <p className="text-sm mt-0.5" style={{ color: "#859399" }}>Manage your plan, monitor usage, and upgrade when ready.</p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-panel rounded-xl h-24 animate-shimmer" />
          ))}
        </div>
      ) : (
        <>
          {/* Current plan banner */}
          <div className="glass-panel rounded-2xl p-6 mb-6" style={{ borderLeft: "3px solid #00d1ff" }}>
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
                    <h2 className="font-headline font-bold text-lg" style={{ color: "#e1e2eb" }}>{plan} Plan</h2>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399" }}>ACTIVE</span>
                  </div>
                  {subscription?.subscription && (
                    <p className="text-xs mt-1" style={{ color: "#859399" }}>
                      {subscription.subscription.cancelAtPeriodEnd ? "Cancels" : "Renews"}{" "}
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
                  Manage Billing
                </button>
              )}
            </div>
          </div>

          {/* Usage meters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {[
              { label: "Runs This Month", current: usage?.live?.runs ?? 0, limit: limits.runs, icon: "play_circle", color: "#00d1ff" },
              { label: "Tool Calls", current: usage?.live?.toolCalls ?? 0, limit: -1, icon: "build", color: "#a4e6ff" },
              { label: "Companies", current: 0, limit: limits.companies, icon: "business", color: "#34d399" },
              { label: "Channels", current: 0, limit: -1, icon: "hub", color: "#fbbf24", text: limits.channels },
            ].map((m) => {
              const unlimited = m.limit < 0;
              const pct = unlimited ? 0 : Math.min(100, (m.current / m.limit) * 100);
              const danger = !unlimited && pct >= 80;
              return (
                <div key={m.label} className="glass-panel rounded-xl p-4">
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

          {/* Plans comparison */}
          <h2 className="font-headline font-bold text-base mb-4" style={{ color: "#e1e2eb" }}>Compare Plans</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {[
              {
                name: "Free", price: "$0", priceNote: "forever", id: "FREE", color: "#859399",
                features: ["1 company", "10 runs/month", "TikTok + LinkedIn", "Community support", "Basic analytics"],
              },
              {
                name: "Pro", price: "$49", priceNote: "/month", id: "PRO", color: "#00d1ff", popular: true,
                features: ["5 companies", "100 runs/month", "All channels", "CRM sync (HubSpot)", "Priority support", "Blueprint sharing", "Advanced analytics"],
              },
              {
                name: "Enterprise", price: "Custom", priceNote: "contact us", id: "ENTERPRISE", color: "#e0b6ff",
                features: ["Unlimited everything", "SSO / SAML", "Dedicated SLA", "Custom integrations", "White-label option", "On-premise deployment"],
              },
            ].map((p) => (
              <div
                key={p.id}
                className="glass-panel rounded-2xl p-6 flex flex-col relative overflow-hidden"
                style={{ border: plan === p.id ? "1.5px solid rgba(0,209,255,0.4)" : "1.5px solid rgba(255,255,255,0.06)" }}
              >
                {(p as any).popular && plan !== p.id && (
                  <div
                    className="absolute top-0 right-0 px-3 py-1 text-[10px] font-bold rounded-bl-xl"
                    style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white" }}
                  >
                    POPULAR
                  </div>
                )}
                <p className="font-headline font-bold text-base mb-1" style={{ color: "#e1e2eb" }}>{p.name}</p>
                <div className="mb-4">
                  <span className="font-headline font-bold text-2xl" style={{ color: p.color }}>{p.price}</span>
                  <span className="text-xs ml-1" style={{ color: "#3c494e" }}>{p.priceNote}</span>
                </div>
                {plan === p.id && (
                  <span className="inline-block mb-3 px-2.5 py-0.5 rounded-full text-[10px] font-bold self-start" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" }}>
                    Current Plan
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
                    {upgradeLoading ? "Processing..." : `Upgrade to ${p.name}`}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Usage history */}
          {usage?.meters && usage.meters.length > 0 && (
            <>
              <h2 className="font-headline font-bold text-base mb-4" style={{ color: "#e1e2eb" }}>Usage History</h2>
              <div className="glass-panel rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: "#859399" }}>Metric</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold" style={{ color: "#859399" }}>Value</th>
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
