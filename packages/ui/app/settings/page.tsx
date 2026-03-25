"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

interface BillingUsage {
  plan: string;
  period: { start: string; end: string };
  meters: { metric: string; value: number }[];
  live: { runs: number; toolCalls: number };
}

interface BillingSubscription {
  plan: string;
  stripeCustomerId: string | null;
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
}

const PLAN_LIMITS: Record<string, { runs: number; companies: number }> = {
  FREE: { runs: 10, companies: 1 },
  PRO: { runs: 100, companies: 5 },
  ENTERPRISE: { runs: -1, companies: -1 },
};

export default function SettingsPage() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const tenantId = useAppStore((s) => s.tenantId);
  const clearAuth = useAppStore((s) => s.clearAuth);
  const [billingUsage, setBillingUsage] = useState<BillingUsage | null>(null);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [referral, setReferral] = useState<{ code: string; stats: any; referrals: any[] } | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemResult, setRedeemResult] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      router.push("/login");
      return;
    }
    api.billingUsage(token).then(setBillingUsage).catch(() => {});
    api.billingSubscription(token).then(setSubscription).catch(() => {});
    api.getReferral(token).then(setReferral).catch(() => {});
  }, [token, router]);

  if (!token) return null;

  function handleLogout() {
    clearAuth();
    router.push("/login");
  }

  async function handleUpgrade(plan: "PRO" | "ENTERPRISE") {
    setUpgradeLoading(true);
    try {
      const { url } = await api.billingCheckout(token!, plan);
      window.location.href = url;
    } catch (err) {
      alert((err as Error).message);
    }
    setUpgradeLoading(false);
  }

  async function handleManageBilling() {
    try {
      const { url } = await api.billingPortal(token!);
      window.location.href = url;
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const currentPlan = billingUsage?.plan ?? "FREE";
  const limits = PLAN_LIMITS[currentPlan] ?? PLAN_LIMITS.FREE;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Manage your account, billing, and integrations</p>
      </div>

      <div className="space-y-6">
        {/* Auth Info */}
        <div className="card-glass p-6">
          <h2 className="text-base font-semibold text-slate-200 mb-4">Authentication</h2>
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b border-white/[0.06]">
              <span className="text-slate-500 text-sm">Tenant ID</span>
              <span className="font-mono text-sm bg-white/[0.06] text-slate-400 px-2 py-1 rounded-lg border border-white/[0.08]">
                {tenantId ? `${tenantId.slice(0, 4)}...${tenantId.slice(-4)}` : "—"}
              </span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-slate-500 text-sm">Token</span>
              <span className="font-mono text-sm bg-white/[0.06] text-slate-400 px-2 py-1 rounded-lg border border-white/[0.08]">
                {token.slice(0, 20)}...
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="mt-2 px-4 py-2 rounded-xl text-sm font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Billing & Usage */}
        <div className="card-glass p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-200">Plan & Usage</h2>
            {subscription?.stripeCustomerId && (
              <button
                onClick={handleManageBilling}
                className="text-sm text-brand-400 hover:text-brand-300 transition-colors"
              >
                Manage Billing
              </button>
            )}
          </div>

          {/* Current plan badge */}
          <div className="flex items-center gap-3 mb-4">
            <span className={`text-sm font-bold px-3 py-1 rounded-full border ${
              currentPlan === "ENTERPRISE" ? "bg-purple-500/10 text-purple-400 border-purple-500/20" :
              currentPlan === "PRO" ? "bg-brand-500/10 text-brand-400 border-brand-500/20" :
              "bg-slate-500/10 text-slate-400 border-slate-500/20"
            }`}>
              {currentPlan}
            </span>
            {subscription?.subscription && (
              <span className="text-xs text-slate-500">
                {subscription.subscription.cancelAtPeriodEnd
                  ? `Cancels ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}`
                  : `Renews ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}`
                }
              </span>
            )}
          </div>

          {/* Usage meters */}
          {billingUsage && (
            <div className="space-y-3 mb-6">
              <UsageBar
                label="Runs This Month"
                current={billingUsage.live.runs}
                limit={limits.runs}
              />
              <div className="flex justify-between text-sm py-1">
                <span className="text-slate-500">Tool Calls This Month</span>
                <span className="font-semibold text-slate-300">{billingUsage.live.toolCalls}</span>
              </div>
              {billingUsage.meters.map((m) => (
                <div key={m.metric} className="flex justify-between text-sm py-1">
                  <span className="text-slate-500 capitalize">{m.metric.replace(/_/g, " ")}</span>
                  <span className="font-semibold text-slate-300">{m.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Plan comparison */}
          <div className="grid grid-cols-3 gap-4">
            <PlanCard
              name="Free"
              price="$0"
              features={["1 company", "10 runs/month", "TikTok + LinkedIn", "Real outputs"]}
              current={currentPlan === "FREE"}
              onSelect={undefined}
            />
            <PlanCard
              name="Pro"
              price="$49/mo"
              features={["5 companies", "100 runs/month", "All channels", "CRM sync", "Priority support"]}
              current={currentPlan === "PRO"}
              onSelect={currentPlan === "FREE" ? () => handleUpgrade("PRO") : undefined}
              loading={upgradeLoading}
            />
            <PlanCard
              name="Enterprise"
              price="Custom"
              features={["Unlimited companies", "Unlimited runs", "Custom integrations", "SSO", "SLA guarantee"]}
              current={currentPlan === "ENTERPRISE"}
              onSelect={currentPlan !== "ENTERPRISE" ? () => handleUpgrade("ENTERPRISE") : undefined}
              loading={upgradeLoading}
            />
          </div>
        </div>

        {/* Referral Program */}
        <div className="card-glass p-6">
          <h2 className="text-base font-semibold text-slate-200 mb-2">Referral Program</h2>
          <p className="text-sm text-slate-500 mb-4">
            Share your referral code and both you and your friend get 5 bonus runs!
          </p>

          {referral && (
            <div className="space-y-4">
              <div className="bg-brand-500/10 border border-brand-500/20 rounded-xl p-4">
                <p className="text-xs text-brand-400 mb-1 font-semibold uppercase tracking-wide">Your Referral Code</p>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-lg font-bold text-slate-100">{referral.code}</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(referral.code)}
                    className="text-xs gradient-brand text-white px-3 py-1 rounded-lg hover:shadow-md hover:shadow-brand-500/20 transition-all"
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-3 bg-white/[0.04] border border-white/[0.08] rounded-xl">
                  <p className="text-2xl font-bold text-slate-100">{referral.stats.totalReferred}</p>
                  <p className="text-xs text-slate-500">Referred</p>
                </div>
                <div className="text-center p-3 bg-white/[0.04] border border-white/[0.08] rounded-xl">
                  <p className="text-2xl font-bold text-emerald-400">{referral.stats.converted}</p>
                  <p className="text-xs text-slate-500">Converted</p>
                </div>
                <div className="text-center p-3 bg-white/[0.04] border border-white/[0.08] rounded-xl">
                  <p className="text-2xl font-bold text-brand-400">{referral.stats.rewardsApplied}</p>
                  <p className="text-xs text-slate-500">Rewards</p>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-slate-300 mb-2">Redeem a Code</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={redeemCode}
                    onChange={(e) => setRedeemCode(e.target.value)}
                    placeholder="AICOS-XXXXXXXX"
                    className="flex-1 bg-white/[0.04] border border-white/[0.08] text-slate-300 rounded-xl px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-brand-500/50 outline-none"
                  />
                  <button
                    onClick={async () => {
                      if (!redeemCode.trim()) return;
                      try {
                        const res = await api.redeemReferral(token!, redeemCode.trim());
                        setRedeemResult(res.reward);
                        setRedeemCode("");
                      } catch (err) {
                        setRedeemResult((err as Error).message);
                      }
                    }}
                    className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-emerald-500 transition-colors"
                  >
                    Redeem
                  </button>
                </div>
                {redeemResult && (
                  <p className="text-sm mt-2 text-emerald-400">{redeemResult}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Integrations */}
        <div className="card-glass p-6">
          <h2 className="text-base font-semibold text-slate-200 mb-4">Integrations</h2>
          <div className="space-y-1">
            <IntegrationRow name="HubSpot CRM" description="Sync contacts and deals bidirectionally" envVar="HUBSPOT_ACCESS_TOKEN" />
            <IntegrationRow name="Stripe Billing" description="Usage-based billing and subscription management" envVar="STRIPE_SECRET_KEY" />
            <IntegrationRow name="SendGrid Email" description="Transactional and outreach email delivery" envVar="SENDGRID_API_KEY" />
            <IntegrationRow name="TikTok" description="Publish and analyze TikTok content" envVar="TIKTOK_*" />
            <IntegrationRow name="LinkedIn" description="Publish and analyze LinkedIn content" envVar="LINKEDIN_*" />
            <IntegrationRow name="Anthropic (Claude)" description="AI agent reasoning and tool use" envVar="ANTHROPIC_API_KEY" />
          </div>
        </div>

        {/* Governance */}
        <div className="card-glass p-6">
          <h2 className="text-base font-semibold text-slate-200 mb-4">Governance Config</h2>
          <div className="space-y-1">
            <GovernanceItem label="Spend Approval Required" value="Yes (all spend actions)" />
            <GovernanceItem label="Loop Detection Threshold" value="5 consecutive failures" />
            <GovernanceItem label="Cost Anomaly Threshold" value="20% of run budget" />
            <GovernanceItem label="Spam Protection" value="3+ unanswered outreach = blocked" />
            <GovernanceItem label="Memory Auto-Promote" value="confidence >= 0.7, useCount >= 3, age >= 7d" />
            <GovernanceItem label="Holding Brain Requirement" value="2+ companies with same pattern" />
          </div>
        </div>
      </div>
    </div>
  );
}

function UsageBar({ label, current, limit }: { label: string; current: number; limit: number }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, (current / limit) * 100);
  const danger = !unlimited && pct >= 80;

  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-slate-500">{label}</span>
        <span className={`font-semibold ${danger ? "text-red-400" : "text-slate-300"}`}>
          {current}{unlimited ? "" : ` / ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className="w-full bg-white/[0.06] rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${danger ? "bg-red-500" : "gradient-brand"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function PlanCard({ name, price, features, current, onSelect, loading }: {
  name: string; price: string; features: string[]; current: boolean;
  onSelect?: () => void; loading?: boolean;
}) {
  return (
    <div className={`rounded-2xl p-4 border transition-all ${current ? "border-brand-500/40 bg-brand-500/10" : "border-white/[0.08] bg-white/[0.03]"}`}>
      <h3 className="font-semibold text-slate-200">{name}</h3>
      <p className="text-lg font-bold text-slate-100 mt-1">{price}</p>
      {current && <span className="text-xs gradient-brand text-white px-2 py-0.5 rounded-lg mt-2 inline-block">Current</span>}
      <ul className="text-xs text-slate-500 space-y-1 mt-3">
        {features.map((f) => <li key={f} className="flex items-center gap-1"><span className="text-slate-600">·</span> {f}</li>)}
      </ul>
      {onSelect && !current && (
        <button
          onClick={onSelect}
          disabled={loading}
          className="mt-3 w-full gradient-brand text-white px-3 py-1.5 rounded-xl text-sm font-semibold hover:shadow-md hover:shadow-brand-500/20 disabled:opacity-50 transition-all"
        >
          {loading ? "Redirecting..." : "Upgrade"}
        </button>
      )}
    </div>
  );
}

function IntegrationRow({ name, description, envVar }: {
  name: string; description: string; envVar: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/[0.06] last:border-0">
      <div>
        <p className="font-medium text-sm text-slate-300">{name}</p>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      <span className="text-xs text-slate-600 font-mono">{envVar}</span>
    </div>
  );
}

function GovernanceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-2.5 border-b border-white/[0.06] last:border-0">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className="font-mono text-xs bg-white/[0.06] text-slate-400 px-2 py-1 rounded-lg border border-white/[0.08]">{value}</span>
    </div>
  );
}
