"use client";

import { useEffect, useState } from "react";
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
  const token = useAppStore((s) => s.token);
  const tenantId = useAppStore((s) => s.tenantId);
  const clearAuth = useAppStore((s) => s.clearAuth);
  const [billingUsage, setBillingUsage] = useState<BillingUsage | null>(null);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.billingUsage(token).then(setBillingUsage).catch(() => {});
    api.billingSubscription(token).then(setSubscription).catch(() => {});
  }, [token]);

  if (!token) return <p className="text-gray-500">Please login first.</p>;

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
    <div>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <div className="space-y-6">
        {/* Auth Info */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Authentication</h2>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Tenant ID</span>
              <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{tenantId ?? "—"}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Token</span>
              <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                {token.slice(0, 20)}...
              </span>
            </div>
            <button
              onClick={clearAuth}
              className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 text-sm mt-2"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Billing & Usage */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Plan & Usage</h2>
            {subscription?.stripeCustomerId && (
              <button
                onClick={handleManageBilling}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Manage Billing
              </button>
            )}
          </div>

          {/* Current plan badge */}
          <div className="flex items-center gap-3 mb-4">
            <span className={`text-sm font-bold px-3 py-1 rounded-full ${
              currentPlan === "ENTERPRISE" ? "bg-purple-100 text-purple-800" :
              currentPlan === "PRO" ? "bg-blue-100 text-blue-800" :
              "bg-gray-100 text-gray-800"
            }`}>
              {currentPlan}
            </span>
            {subscription?.subscription && (
              <span className="text-xs text-gray-500">
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
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Tool Calls This Month</span>
                <span className="font-semibold">{billingUsage.live.toolCalls}</span>
              </div>
              {billingUsage.meters.map((m) => (
                <div key={m.metric} className="flex justify-between text-sm">
                  <span className="text-gray-500 capitalize">{m.metric.replace(/_/g, " ")}</span>
                  <span className="font-semibold">{m.value}</span>
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

        {/* Integrations */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Integrations</h2>
          <div className="space-y-4">
            <IntegrationRow name="HubSpot CRM" description="Sync contacts and deals bidirectionally" envVar="HUBSPOT_ACCESS_TOKEN" />
            <IntegrationRow name="Stripe Billing" description="Usage-based billing and subscription management" envVar="STRIPE_SECRET_KEY" />
            <IntegrationRow name="SendGrid Email" description="Transactional and outreach email delivery" envVar="SENDGRID_API_KEY" />
            <IntegrationRow name="TikTok" description="Publish and analyze TikTok content" envVar="TIKTOK_*" />
            <IntegrationRow name="LinkedIn" description="Publish and analyze LinkedIn content" envVar="LINKEDIN_*" />
            <IntegrationRow name="Anthropic (Claude)" description="AI agent reasoning and tool use" envVar="ANTHROPIC_API_KEY" />
          </div>
        </div>

        {/* Governance */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Governance Config</h2>
          <div className="space-y-3 text-sm">
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
        <span className="text-gray-500">{label}</span>
        <span className={`font-semibold ${danger ? "text-red-600" : ""}`}>
          {current}{unlimited ? "" : ` / ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className={`h-2 rounded-full ${danger ? "bg-red-500" : "bg-blue-500"}`}
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
    <div className={`border rounded-lg p-4 ${current ? "border-blue-500 bg-blue-50" : ""}`}>
      <h3 className="font-semibold">{name}</h3>
      <p className="text-lg font-bold mt-1">{price}</p>
      {current && <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded mt-2 inline-block">Current</span>}
      <ul className="text-xs text-gray-600 space-y-1 mt-3">
        {features.map((f) => <li key={f}>- {f}</li>)}
      </ul>
      {onSelect && !current && (
        <button
          onClick={onSelect}
          disabled={loading}
          className="mt-3 w-full bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
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
    <div className="flex items-center justify-between py-2 border-b last:border-0">
      <div>
        <p className="font-medium text-sm">{name}</p>
        <p className="text-xs text-gray-500">{description}</p>
      </div>
      <span className="text-xs text-gray-400 font-mono">{envVar}</span>
    </div>
  );
}

function GovernanceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-gray-600">{label}</span>
      <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{value}</span>
    </div>
  );
}
