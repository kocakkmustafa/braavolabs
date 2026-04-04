"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";
import { useAuthGuard } from "../../lib/useAuthGuard";

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
    id: string; status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean;
  } | null;
}

const PLAN_LIMITS: Record<string, { runs: number; companies: number }> = {
  FREE: { runs: 10, companies: 1 },
  PRO: { runs: 100, companies: 5 },
  ENTERPRISE: { runs: -1, companies: -1 },
};

const NAV_ITEMS = [
  { id: "profile",       label: "Profile",         icon: "person" },
  { id: "notifications", label: "Notifications",   icon: "notifications" },
  { id: "billing",       label: "Plan & Usage",    icon: "credit_card" },
  { id: "integrations",  label: "Integrations",    icon: "hub" },
  { id: "governance",    label: "Governance",      icon: "security" },
  { id: "api",           label: "API & Auth",      icon: "terminal" },
  { id: "webhooks",      label: "Webhooks",        icon: "webhook" },
  { id: "referral",      label: "Referral",        icon: "redeem" },
];

export default function SettingsPage() {
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const tenantId = useAppStore((s) => s.tenantId);
  const clearAuth = useAppStore((s) => s.clearAuth);

  const [active, setActive] = useState("profile");
  const [billingUsage, setBillingUsage] = useState<BillingUsage | null>(null);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [referral, setReferral] = useState<{ code: string; stats: any } | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemResult, setRedeemResult] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notifs, setNotifs] = useState({
    runCompleted: true, spendApproval: true, pipelineErrors: true,
    weeklyDigest: false, marketing: false,
  });

  // Integration state
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [providers, setProviders] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [intLoading, setIntLoading] = useState(false);
  const [editProvider, setEditProvider] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ provider: string; success: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    api.billingUsage(token).then(setBillingUsage).catch(() => {});
    api.billingSubscription(token).then(setSubscription).catch(() => {});
    api.getReferral(token).then(setReferral).catch(() => {});
    api.listProviders(token).then(setProviders).catch(() => {});
    api.listCompanies(token).then((c: any[]) => {
      setCompanies(c);
      if (c.length > 0 && !selectedCompanyId) setSelectedCompanyId(c[0].id);
    }).catch(() => {});
  }, [token, hydrated]);

  // Load integrations when company changes
  useEffect(() => {
    if (!token || !selectedCompanyId) return;
    setIntLoading(true);
    api.listIntegrations(token, selectedCompanyId)
      .then(setIntegrations)
      .catch(() => {})
      .finally(() => setIntLoading(false));
  }, [token, selectedCompanyId]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  async function handleUpgrade(plan: "PRO" | "ENTERPRISE") {
    setUpgradeLoading(true);
    setBillingError(null);
    try { const { url } = await api.billingCheckout(token!, plan); window.location.href = url; }
    catch (err) { console.error("Billing checkout failed:", err); setBillingError((err as Error).message); }
    setUpgradeLoading(false);
  }

  async function handleManageBilling() {
    setBillingError(null);
    try { const { url } = await api.billingPortal(token!); window.location.href = url; }
    catch (err) { console.error("Billing portal failed:", err); setBillingError((err as Error).message); }
  }

  function handleSave() { setSaved(true); setTimeout(() => setSaved(false), 2000); }

  const currentPlan = billingUsage?.plan ?? "FREE";
  const limits = PLAN_LIMITS[currentPlan] ?? PLAN_LIMITS.FREE;

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      {/* Top bar */}
      <header
        className="sticky top-0 z-40 flex items-center justify-between px-8 h-16 font-headline"
        style={{
          background: "rgba(12,12,29,0.85)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(71,70,89,0.15)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        }}
      >
        <div className="flex items-center gap-6">
          <span
            className="text-sm font-bold tracking-[0.1em] uppercase"
            style={{ color: "#00d1ff" }}
          >
            Settings
          </span>
          <nav className="hidden md:flex gap-6">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className="text-[11px] font-bold uppercase tracking-widest transition-all pb-[2px]"
                style={{
                  color: active === item.id ? "#00d1ff" : "rgba(230,227,251,0.5)",
                  borderBottom: active === item.id ? "2px solid #00d1ff" : "2px solid transparent",
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
        <button
          onClick={() => { clearAuth(); router.push("/login"); }}
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
          style={{ background: "rgba(255,180,171,0.08)", color: "#ffb4ab" }}
        >
          <span className="material-symbols-outlined text-sm">logout</span>
          Sign Out
        </button>
      </header>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-8 py-10 animate-fade-in">

        {/* Profile */}
        {active === "profile" && (
          <Section title="Profile" subtitle="Manage your personal information and preferences">
            <div
              className="flex items-center gap-5 mb-8 pb-8"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
            >
              <div className="relative">
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-2xl font-bold font-headline"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", color: "white" }}
                >
                  {tenantId ? tenantId.slice(0, 2).toUpperCase() : "AI"}
                </div>
                <button
                  className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ background: "#272a31", border: "2px solid #0a0d14" }}
                >
                  <span className="material-symbols-outlined text-sm" style={{ color: "#bbc9cf" }}>photo_camera</span>
                </button>
              </div>
              <div>
                <p className="font-headline font-bold text-lg" style={{ color: "#e1e2eb" }}>My Workspace</p>
                <p className="text-sm" style={{ color: "#859399" }}>Member since 2025</p>
                <span
                  className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold mt-1.5"
                  style={{
                    background: currentPlan === "PRO" ? "rgba(109,17,173,0.2)" : "rgba(255,255,255,0.06)",
                    color: currentPlan === "PRO" ? "#e0b6ff" : "#859399",
                  }}
                >
                  {currentPlan}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <Field label="First Name" placeholder="Jane" />
              <Field label="Last Name" placeholder="Smith" />
            </div>
            <Field label="Email" placeholder="you@example.com" badge="Verified" />
            <div className="mt-4"><Field label="Phone" placeholder="+1 (555) 000-0000" /></div>
            <div className="mt-4">
              <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Bio</label>
              <textarea
                rows={3}
                className="w-full px-4 py-2.5 rounded-lg text-sm outline-none resize-none transition-all"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                placeholder="Tell us about yourself..."
                onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
              />
            </div>
            <SaveBar onSave={handleSave} saved={saved} />
          </Section>
        )}

        {/* Notifications */}
        {active === "notifications" && (
          <Section title="Notifications" subtitle="Control when and how you get notified">
            <div className="space-y-0">
              {([
                { key: "spendApproval" as const, label: "Spend approval required", desc: "Critical: agent wants to spend money — requires immediate action", critical: true },
                { key: "runCompleted" as const, label: "Agent run completed", desc: "Notified when a pipeline run finishes successfully" },
                { key: "pipelineErrors" as const, label: "Pipeline errors", desc: "Alerts for failed runs and loop detection triggers" },
                { key: "weeklyDigest" as const, label: "Weekly digest", desc: "Summary of activity across all your companies" },
                { key: "marketing" as const, label: "Marketing emails", desc: "Product updates and feature announcements" },
              ]).map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between py-4"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <div className="flex items-start gap-3">
                    {item.critical && (
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded mt-0.5 flex-shrink-0"
                        style={{ background: "rgba(255,180,171,0.12)", color: "#ffb4ab" }}
                      >
                        CRITICAL
                      </span>
                    )}
                    <div>
                      <p className="text-sm font-medium" style={{ color: "#e1e2eb" }}>{item.label}</p>
                      <p className="text-xs mt-0.5" style={{ color: "#859399" }}>{item.desc}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setNotifs((n) => ({ ...n, [item.key]: !n[item.key] }))}
                    className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative ml-4"
                    style={{ background: notifs[item.key] ? "#00d1ff" : "rgba(255,255,255,0.08)" }}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                      style={{
                        background: "white",
                        left: notifs[item.key] ? "calc(100% - 22px)" : "2px",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    />
                  </button>
                </div>
              ))}
            </div>
            <SaveBar onSave={handleSave} saved={saved} />
          </Section>
        )}

        {/* Billing */}
        {active === "billing" && (
          <Section title="Plan & Usage" subtitle="Manage your subscription and monitor usage metrics">
            {billingError && (
              <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 12, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171", fontSize: 14 }}>
                {billingError}
              </div>
            )}
            <div
              className="flex items-center justify-between mb-6 pb-6"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="px-3 py-1 rounded-full text-sm font-bold"
                  style={{
                    background: currentPlan === "PRO" ? "rgba(109,17,173,0.2)" : "rgba(255,255,255,0.06)",
                    color: currentPlan === "PRO" ? "#e0b6ff" : "#bbc9cf",
                    border: currentPlan === "PRO" ? "1px solid rgba(109,17,173,0.35)" : "none",
                  }}
                >
                  {currentPlan} Plan
                </span>
                {subscription?.subscription && (
                  <span className="text-xs" style={{ color: "#859399" }}>
                    {subscription.subscription.cancelAtPeriodEnd
                      ? `Cancels ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}`
                      : `Renews ${new Date(subscription.subscription.currentPeriodEnd).toLocaleDateString()}`}
                  </span>
                )}
              </div>
              {subscription?.stripeCustomerId && (
                <button
                  onClick={handleManageBilling}
                  className="text-sm font-medium transition-all hover:opacity-80"
                  style={{ color: "#00d1ff" }}
                >
                  Manage Billing →
                </button>
              )}
            </div>

            {billingUsage && (
              <div className="space-y-4 mb-8">
                <UsageBar label="Runs This Month" current={billingUsage.live.runs} limit={limits.runs} />
                <div className="flex justify-between text-sm">
                  <span style={{ color: "#859399" }}>Tool Calls</span>
                  <span className="font-semibold" style={{ color: "#bbc9cf" }}>{billingUsage.live.toolCalls}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              {[
                { name: "Free", price: "$0", id: "FREE", color: "#859399", features: ["1 company", "10 runs/month", "TikTok + LinkedIn"] },
                { name: "Pro", price: "$49/mo", id: "PRO", color: "#00d1ff", popular: true, features: ["5 companies", "Unlimited runs", "All channels", "CRM sync"] },
                { name: "Enterprise", price: "Custom", id: "ENTERPRISE", color: "#e0b6ff", features: ["Unlimited everything", "SSO", "SLA"] },
              ].map((plan) => (
                <div
                  key={plan.id}
                  className="rounded-xl p-4 flex flex-col"
                  style={{
                    background: currentPlan === plan.id ? "rgba(0,209,255,0.06)" : "rgba(255,255,255,0.02)",
                    border: currentPlan === plan.id ? "1.5px solid rgba(0,209,255,0.3)" : "1.5px solid rgba(255,255,255,0.06)",
                  }}
                >
                  {(plan as any).popular && currentPlan !== plan.id && (
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full mb-2 self-start"
                      style={{ background: "rgba(0,209,255,0.12)", color: "#00d1ff" }}
                    >
                      Most Popular
                    </span>
                  )}
                  <p className="font-headline font-semibold text-sm mb-0.5" style={{ color: "#e1e2eb" }}>{plan.name}</p>
                  <p className="text-lg font-bold font-headline mb-2" style={{ color: plan.color }}>{plan.price}</p>
                  {currentPlan === plan.id && (
                    <span className="text-xs px-2 py-0.5 rounded-full mb-2 self-start" style={{ background: "rgba(0,209,255,0.1)", color: "#00d1ff" }}>Current</span>
                  )}
                  <ul className="text-xs space-y-1 mb-4 flex-1" style={{ color: "#859399" }}>
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-1.5">
                        <div className="w-1 h-1 rounded-full" style={{ background: plan.color }} />
                        {f}
                      </li>
                    ))}
                  </ul>
                  {currentPlan !== plan.id && plan.id !== "FREE" && (
                    <button
                      onClick={() => handleUpgrade(plan.id as "PRO" | "ENTERPRISE")}
                      disabled={upgradeLoading}
                      className="w-full py-1.5 rounded-lg text-xs font-bold transition-all hover:opacity-90 disabled:opacity-50"
                      style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", color: "white" }}
                    >
                      Upgrade
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Integrations */}
        {active === "integrations" && (
          <Section title="Integrations" subtitle="Connect external services to your AI companies">
            {/* Company selector */}
            <div className="mb-6">
              <label className="text-xs font-semibold uppercase tracking-wider mb-2 block" style={{ color: "#859399" }}>
                Company
              </label>
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl text-sm"
                style={{ background: "rgba(255,255,255,0.04)", color: "#e1e2eb", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id} style={{ background: "#0d1117" }}>{c.name}</option>
                ))}
                {companies.length === 0 && <option value="">No companies found</option>}
              </select>
            </div>

            {intLoading ? (
              <div className="text-center py-8">
                <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-2" style={{ borderColor: "#00d1ff", borderTopColor: "transparent" }} />
                <p className="text-xs" style={{ color: "#859399" }}>Loading integrations...</p>
              </div>
            ) : (
              <div className="space-y-3">
                {providers.map((prov) => {
                  const existing = integrations.find((i: any) => i.provider === prov.provider);
                  const isEditing = editProvider === prov.provider;
                  const statusColor = existing?.status === "ACTIVE" ? "#22c55e" : existing?.status === "ERROR" ? "#ef4444" : existing?.status === "PENDING" ? "#f59e0b" : "#3c494e";
                  const statusLabel = existing?.status ?? "Not Connected";

                  return (
                    <div
                      key={prov.provider}
                      className="rounded-xl overflow-hidden"
                      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}
                    >
                      {/* Provider header */}
                      <div
                        className="flex items-center justify-between px-5 py-4 cursor-pointer"
                        onClick={() => {
                          if (isEditing) {
                            setEditProvider(null);
                          } else {
                            setEditProvider(prov.provider);
                            setEditFields({});
                            setTestResult(null);
                          }
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-xl">{prov.icon}</span>
                          <div>
                            <p className="text-sm font-medium" style={{ color: "#e1e2eb" }}>{prov.name}</p>
                            <p className="text-xs" style={{ color: "#859399" }}>{prov.description}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span
                            className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full"
                            style={{ background: `${statusColor}20`, color: statusColor }}
                          >
                            {statusLabel}
                          </span>
                          <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#859399", transform: isEditing ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                            expand_more
                          </span>
                        </div>
                      </div>

                      {/* Expanded edit form */}
                      {isEditing && (
                        <div className="px-5 pb-5 pt-1" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          {/* Setup guide */}
                          <div className="mb-4 p-3 rounded-lg" style={{ background: "rgba(0,209,255,0.05)", border: "1px solid rgba(0,209,255,0.1)" }}>
                            <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#00d1ff" }}>Setup Guide</p>
                            <pre className="text-xs whitespace-pre-wrap" style={{ color: "#a4e6ff" }}>
                              {prov.setupGuide}
                            </pre>
                            {prov.docsUrl && (
                              <a href={prov.docsUrl} target="_blank" rel="noopener noreferrer" className="text-xs mt-2 inline-block" style={{ color: "#00d1ff" }}>
                                View Documentation →
                              </a>
                            )}
                          </div>

                          {/* Credential fields */}
                          <div className="space-y-3">
                            {prov.fields.map((field: any) => (
                              <div key={field.key}>
                                <label className="text-xs font-medium mb-1 block" style={{ color: "#bbc9cf" }}>
                                  {field.label}
                                  {existing?.fieldsSet?.includes(field.key) && (
                                    <span className="ml-2 text-[10px]" style={{ color: "#22c55e" }}>(saved)</span>
                                  )}
                                </label>
                                <input
                                  type={field.type}
                                  placeholder={field.placeholder}
                                  value={editFields[field.key] ?? ""}
                                  onChange={(e) => setEditFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                  className="w-full px-3 py-2 rounded-lg text-sm font-mono"
                                  style={{ background: "rgba(0,0,0,0.3)", color: "#e1e2eb", border: "1px solid rgba(255,255,255,0.08)" }}
                                />
                              </div>
                            ))}
                          </div>

                          {/* Test result */}
                          {testResult && testResult.provider === prov.provider && (
                            <div
                              className="mt-3 p-3 rounded-lg text-xs"
                              style={{
                                background: testResult.success ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                                border: `1px solid ${testResult.success ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
                                color: testResult.success ? "#22c55e" : "#ef4444",
                              }}
                            >
                              {testResult.success ? "Connection successful!" : `Error: ${testResult.error}`}
                            </div>
                          )}

                          {/* Action buttons */}
                          <div className="flex gap-2 mt-4">
                            <button
                              onClick={async () => {
                                if (!token || !selectedCompanyId) return;
                                const filledFields = Object.fromEntries(
                                  Object.entries(editFields).filter(([_, v]) => v.trim() !== "")
                                );
                                if (Object.keys(filledFields).length === 0) return;
                                await api.saveIntegration(token, selectedCompanyId, prov.provider, filledFields);
                                // Reload
                                const updated = await api.listIntegrations(token, selectedCompanyId);
                                setIntegrations(updated);
                                setEditFields({});
                              }}
                              className="px-4 py-2 rounded-lg text-xs font-semibold"
                              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", color: "white" }}
                            >
                              Save Credentials
                            </button>
                            <button
                              onClick={async () => {
                                if (!token || !selectedCompanyId) return;
                                const result = await api.testIntegration(token, selectedCompanyId, prov.provider);
                                setTestResult({ provider: prov.provider, success: result.success, error: result.error });
                                // Reload integrations
                                const updated = await api.listIntegrations(token, selectedCompanyId);
                                setIntegrations(updated);
                              }}
                              className="px-4 py-2 rounded-lg text-xs font-semibold"
                              style={{ background: "rgba(255,255,255,0.06)", color: "#bbc9cf", border: "1px solid rgba(255,255,255,0.08)" }}
                            >
                              Test Connection
                            </button>
                            {existing && (
                              <button
                                onClick={async () => {
                                  if (!token || !selectedCompanyId) return;
                                  await api.deleteIntegration(token, selectedCompanyId, prov.provider);
                                  const updated = await api.listIntegrations(token, selectedCompanyId);
                                  setIntegrations(updated);
                                }}
                                className="px-4 py-2 rounded-lg text-xs font-semibold ml-auto"
                                style={{ color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.05)" }}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        )}

        {/* Governance */}
        {active === "governance" && (
          <Section title="Governance Config" subtitle="Risk controls and autonomous behavior boundaries">
            <div className="space-y-0">
              {[
                { label: "Spend Approval Required", value: "All spend actions" },
                { label: "Loop Detection Threshold", value: "5 consecutive failures" },
                { label: "Cost Anomaly Threshold", value: "20% of run budget" },
                { label: "Spam Protection", value: "3+ unanswered = blocked" },
                { label: "Memory Auto-Promote", value: "confidence ≥ 0.7, count ≥ 3" },
                { label: "Holding Brain Requirement", value: "2+ companies with pattern" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex justify-between items-center py-3.5"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <span className="text-sm" style={{ color: "#bbc9cf" }}>{item.label}</span>
                  <code
                    className="font-mono text-xs px-2.5 py-1 rounded-lg"
                    style={{ background: "rgba(255,255,255,0.04)", color: "#859399", border: "1px solid rgba(255,255,255,0.06)" }}
                  >
                    {item.value}
                  </code>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* API & Auth */}
        {active === "api" && (
          <Section title="API & Auth" subtitle="Your credentials and access tokens">
            <div className="space-y-4">
              <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "#859399" }}>Tenant ID</p>
                <div className="flex items-center gap-3">
                  <code className="text-sm flex-1 truncate font-mono" style={{ color: "#bbc9cf" }}>
                    {tenantId ? `${tenantId.slice(0, 4)}...${tenantId.slice(-4)}` : "—"}
                  </code>
                  <button
                    className="px-3 py-1 rounded-lg text-xs font-semibold"
                    style={{ background: "rgba(0,209,255,0.1)", color: "#00d1ff", border: "1px solid rgba(0,209,255,0.2)" }}
                    onClick={() => tenantId && navigator.clipboard.writeText(tenantId)}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "#859399" }}>Session Token</p>
                <code className="text-sm font-mono" style={{ color: "#bbc9cf" }}>
                  {token ? `${token.slice(0, 24)}...` : "—"}
                </code>
              </div>
            </div>
          </Section>
        )}

        {/* Webhooks */}
        {active === "webhooks" && (
          <Section title="Webhooks & API Keys" subtitle="Manage webhook endpoints and API access for your companies">
            <div className="space-y-5">
              {/* Webhook endpoint info */}
              <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#00d1ff" }}>webhook</span>
                  <p className="text-sm font-semibold" style={{ color: "#e1e2eb" }}>Incoming Webhooks</p>
                </div>
                <p className="text-xs mb-3" style={{ color: "#859399" }}>
                  External services can trigger pipeline runs by sending POST requests to your webhook endpoints.
                </p>
                <div className="rounded-lg p-3" style={{ background: "rgba(0,0,0,0.2)" }}>
                  <p className="text-[10px] font-semibold tracking-wider mb-1" style={{ color: "#859399" }}>ENDPOINT FORMAT</p>
                  <code className="text-xs font-mono" style={{ color: "#a4e6ff" }}>
                    POST /hooks/:company_slug/:event
                  </code>
                </div>
                <p className="text-xs mt-2" style={{ color: "#3c494e" }}>
                  Replace <code style={{ color: "#a4e6ff" }}>:company_slug</code> with your company slug and <code style={{ color: "#a4e6ff" }}>:event</code> with the event name.
                </p>
              </div>

              {/* API Key display */}
              <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#fbbf24" }}>key</span>
                  <p className="text-sm font-semibold" style={{ color: "#e1e2eb" }}>API Access</p>
                </div>
                <div className="flex items-center gap-3 mb-2">
                  <code className="text-sm flex-1 truncate font-mono" style={{ color: "#bbc9cf" }}>
                    Bearer {token ? `${token.slice(0, 20)}...` : "—"}
                  </code>
                  <button
                    className="px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1"
                    style={{ background: "rgba(0,209,255,0.1)", color: "#00d1ff", border: "1px solid rgba(0,209,255,0.2)" }}
                    onClick={() => token && navigator.clipboard.writeText(token)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 13 }}>content_copy</span>
                    Copy
                  </button>
                </div>
                <p className="text-xs" style={{ color: "#3c494e" }}>Use this token as Bearer auth in API requests. Tokens expire after session ends.</p>
              </div>

              {/* Example events */}
              <div>
                <p className="text-xs font-semibold mb-3" style={{ color: "#bbc9cf" }}>Common Events</p>
                <div className="space-y-0">
                  {[
                    { event: "new_lead", desc: "Trigger acquisition pipeline on new lead", icon: "person_add" },
                    { event: "content_ready", desc: "Content approved for publishing", icon: "check_circle" },
                    { event: "payment_received", desc: "Process payment and update CRM", icon: "payments" },
                    { event: "support_ticket", desc: "Route to customer success agent", icon: "support_agent" },
                  ].map((ev) => (
                    <div
                      key={ev.event}
                      className="flex items-center justify-between py-3"
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                    >
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#859399" }}>{ev.icon}</span>
                        <div>
                          <code className="text-xs font-mono" style={{ color: "#e1e2eb" }}>{ev.event}</code>
                          <p className="text-xs" style={{ color: "#3c494e" }}>{ev.desc}</p>
                        </div>
                      </div>
                      <button
                        className="px-2 py-1 rounded text-[10px] font-semibold"
                        style={{ background: "rgba(255,255,255,0.04)", color: "#859399", border: "1px solid rgba(255,255,255,0.06)" }}
                        onClick={() => navigator.clipboard.writeText(`/hooks/YOUR_COMPANY/${ev.event}`)}
                      >
                        Copy URL
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Webhook test */}
              <div className="p-4 rounded-xl" style={{ background: "rgba(0,209,255,0.04)", border: "1px solid rgba(0,209,255,0.12)" }}>
                <p className="text-xs font-semibold mb-2" style={{ color: "#00d1ff" }}>Test Your Webhook</p>
                <code className="text-xs font-mono block" style={{ color: "#bbc9cf" }}>
                  curl -X POST {typeof window !== "undefined" ? window.location.origin : ""}/api/v1/hooks/YOUR_COMPANY/test \
                </code>
                <code className="text-xs font-mono block ml-4" style={{ color: "#bbc9cf" }}>
                  -H &quot;Authorization: Bearer YOUR_TOKEN&quot; \
                </code>
                <code className="text-xs font-mono block ml-4" style={{ color: "#bbc9cf" }}>
                  -H &quot;Content-Type: application/json&quot; \
                </code>
                <code className="text-xs font-mono block ml-4" style={{ color: "#bbc9cf" }}>
                  -d {`'{"data": "test"}'`}
                </code>
              </div>
            </div>
          </Section>
        )}

        {/* Referral */}
        {active === "referral" && (
          <Section title="Referral Program" subtitle="Share your code — both you and your friend get 5 bonus runs">
            {referral ? (
              <div className="space-y-5">
                <div className="p-5 rounded-xl" style={{ background: "rgba(0,209,255,0.06)", border: "1px solid rgba(0,209,255,0.2)" }}>
                  <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: "#00d1ff" }}>Your Code</p>
                  <div className="flex items-center gap-3">
                    <code className="text-xl font-bold font-mono" style={{ color: "#e1e2eb" }}>{referral.code}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(referral.code)}
                      className="px-3 py-1 rounded-lg text-xs font-bold"
                      style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", color: "white" }}
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Referred", value: referral.stats.totalReferred, color: "#e1e2eb" },
                    { label: "Converted", value: referral.stats.converted, color: "#34d399" },
                    { label: "Rewards", value: referral.stats.rewardsApplied, color: "#00d1ff" },
                  ].map((s) => (
                    <div key={s.label} className="text-center p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                      <p className="text-2xl font-bold font-headline" style={{ color: s.color }}>{s.value}</p>
                      <p className="text-xs mt-0.5" style={{ color: "#859399" }}>{s.label}</p>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-sm font-medium mb-2" style={{ color: "#bbc9cf" }}>Redeem a Code</p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={redeemCode}
                      onChange={(e) => setRedeemCode(e.target.value)}
                      placeholder="AICOS-XXXXXXXX"
                      className="flex-1 px-4 py-2.5 rounded-xl text-sm font-mono outline-none"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                      onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                      onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                    />
                    <button
                      onClick={async () => {
                        if (!redeemCode.trim()) return;
                        try {
                          const res = await api.redeemReferral(token!, redeemCode.trim());
                          setRedeemResult(res.reward); setRedeemCode("");
                        } catch (err) { setRedeemResult((err as Error).message); }
                      }}
                      className="px-5 py-2.5 rounded-xl text-sm font-semibold"
                      style={{ background: "rgba(52,211,153,0.12)", color: "#34d399", border: "1px solid rgba(52,211,153,0.25)" }}
                    >
                      Redeem
                    </button>
                  </div>
                  {redeemResult && <p className="text-sm mt-2" style={{ color: "#34d399" }}>{redeemResult}</p>}
                </div>
              </div>
            ) : (
              <p style={{ color: "#859399" }}>Loading...</p>
            )}
          </Section>
        )}
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-6">
        <h1 className="font-headline font-bold text-xl mb-1" style={{ color: "#e1e2eb" }}>{title}</h1>
        <p className="text-sm" style={{ color: "#859399" }}>{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Field({ label, type = "text", placeholder, badge }: { label: string; type?: string; placeholder: string; badge?: string }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>{label}</label>
      <div className="relative">
        <input
          type={type}
          placeholder={placeholder}
          className="w-full px-4 py-2.5 rounded-lg text-sm outline-none transition-all"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
          onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(0,209,255,0.06)"; }}
          onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; e.currentTarget.style.boxShadow = "none"; }}
        />
        {badge && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399" }}>
            {badge}
          </span>
        )}
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
      <div className="flex justify-between text-sm mb-1.5">
        <span style={{ color: "#859399" }}>{label}</span>
        <span className="font-semibold" style={{ color: danger ? "#ffb4ab" : "#bbc9cf" }}>
          {current}{unlimited ? "" : ` / ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: danger ? "#ff5449" : "linear-gradient(90deg, #00d1ff, #6d11ad)" }}
          />
        </div>
      )}
    </div>
  );
}

function SaveBar({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  return (
    <div className="flex items-center justify-end gap-3 mt-8 pt-5" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
      <button
        className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#859399" }}
      >
        Discard
      </button>
      <button
        onClick={onSave}
        className="px-6 py-2.5 rounded-xl text-sm font-bold transition-all hover:opacity-90"
        style={{
          background: saved ? "rgba(52,211,153,0.15)" : "linear-gradient(135deg, #00d1ff, #6d11ad)",
          border: saved ? "1px solid rgba(52,211,153,0.3)" : "none",
          color: saved ? "#34d399" : "white",
        }}
      >
        {saved ? "\u2713 Saved" : "Save Changes"}
      </button>
      {saved && (
        <span className="text-xs font-medium animate-fade-in" style={{ color: "#34d399" }}>
          Changes saved successfully!
        </span>
      )}
    </div>
  );
}
