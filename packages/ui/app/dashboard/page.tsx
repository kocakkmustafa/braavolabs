"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";
import { sounds } from "../../lib/sounds";
import { timeAgo } from "../../lib/timeAgo";

interface HealthData { activeCompanies: number; activeRuns: number; pendingApprovals: number; }
interface UsageData { totalRuns: number; completedRuns: number; failedRuns: number; successRate: number; }
interface FinanceData { totalCostUsd: number; runCount: number; avgCostPerRun: number; }

export default function DashboardPage() {
  const token = useAppStore((s) => s.token);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!token) { setLoaded(true); return; }
    Promise.all([
      api.health(token).then(setHealth).catch(() => {}),
      api.usage(token).then(setUsage).catch(() => {}),
      api.finance(token).then(setFinance).catch(() => {}),
      api.listCompanies(token).then(setCompanies).catch(() => {}),
    ]).finally(() => setLoaded(true));
  }, [token]);

  // ── Public demo dashboard (not logged in) ──
  if (!token) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in mesh-bg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8" style={{ position: "relative", zIndex: 1 }}>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold font-headline gradient-text">Command Center</h1>
            <p className="text-sm mt-1" style={{ color: "#859399" }}>See what AI Company OS can do — sign in to manage your own companies</p>
          </div>
          <Link href="/login" className="btn-primary self-start sm:self-auto" style={{ textDecoration: "none" }}>Sign In to Get Started</Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8 stagger-children" style={{ position: "relative", zIndex: 1 }}>
          {[
            { label: "Active Companies", value: "1,247", icon: "business", color: "#a4e6ff" },
            { label: "Running Pipelines", value: "89", icon: "play_circle", color: "#34d399" },
            { label: "Pending Approvals", value: "12", icon: "task_alt", color: "#fbbf24" },
            { label: "Total Runs", value: "24.3K", icon: "bolt", color: "#fbbf24" },
            { label: "Total Cost", value: "$1,842", icon: "payments", color: "#c084fc" },
          ].map((m) => (
            <div key={m.label} className="metric-card">
              <div className="flex items-center justify-between mb-3">
                <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center" style={{ background: `${m.color}08` }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: m.color }}>{m.icon}</span>
                </div>
              </div>
              <p className="text-lg sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>{m.value}</p>
              <p className="text-[10px] sm:text-xs mt-0.5" style={{ color: "#859399" }}>{m.label}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" style={{ position: "relative", zIndex: 1 }}>
          <div className="lg:col-span-2">
            <div className="glass-card">
              <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <h2 className="font-semibold font-headline" style={{ color: "#e1e2eb" }}>Example Companies</h2>
              </div>
              <div className="p-4 space-y-1 stagger-children">
                {[
                  { name: "TikTok Growth Agency", status: "ACTIVE", desc: "AI-powered content creation and posting", primitives: ["content", "acquisition", "analytics"] },
                  { name: "SaaS Outbound Sales", status: "ACTIVE", desc: "Automated lead qualification and demo booking", primitives: ["sales", "acquisition", "operations"] },
                  { name: "E-commerce Support Bot", status: "ACTIVE", desc: "24/7 customer support with escalation rules", primitives: ["delivery", "operations", "memory"] },
                ].map((c) => (
                  <div key={c.name} className="interactive-row flex items-center gap-4 px-4 py-3.5">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0 gradient-brand" style={{ boxShadow: "0 4px 12px rgba(0,209,255,0.15)" }}>
                      {c.name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm truncate" style={{ color: "#e1e2eb" }}>{c.name}</p>
                        <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: "#34d399" }}>
                          <span className="status-dot" style={{ background: "#10b981", width: 5, height: 5 }} />
                          {c.status}
                        </span>
                      </div>
                      <p className="text-xs truncate mt-0.5" style={{ color: "#859399" }}>{c.desc}</p>
                    </div>
                    <div className="hidden sm:flex gap-1 shrink-0">
                      {c.primitives.map((p) => (
                        <span key={p} className="text-[10px] px-2 py-0.5 rounded-md font-medium" style={{ background: "rgba(0,209,255,0.06)", color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.12)" }}>
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="glass-card">
              <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <h2 className="font-semibold font-headline" style={{ color: "#e1e2eb" }}>Live Activity</h2>
              </div>
              <div className="p-4 space-y-3 stagger-children">
                {[
                  { action: "Content published → TikTok", time: "2m ago", color: "#34d399" },
                  { action: "Lead scored → 0.87", time: "5m ago", color: "#a4e6ff" },
                  { action: "Invoice reconciled", time: "12m ago", color: "#fbbf24" },
                  { action: "Demo booked → Acme Corp", time: "18m ago", color: "#c084fc" },
                  { action: "Pipeline completed", time: "24m ago", color: "#34d399" },
                ].map((log, i) => (
                  <div key={i} className="flex items-start gap-3 px-2 py-2 interactive-row">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${log.color}0a` }}>
                      <span className="text-[9px] font-bold" style={{ color: log.color }}>AI</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium" style={{ color: "#bbc9cf" }}>{log.action}</p>
                      <p className="text-[11px]" style={{ color: "#3c494e" }}>{log.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="mt-8 glass-card p-6 sm:p-8 text-center animate-pulse-glow" style={{ position: "relative", zIndex: 1 }}>
          <span className="material-symbols-outlined text-3xl mb-3 block" style={{ color: "#00d1ff" }}>rocket_launch</span>
          <h3 className="font-headline font-bold text-lg mb-2 gradient-text">Ready to build your AI company?</h3>
          <p className="text-sm mb-5" style={{ color: "#859399" }}>Create your first autonomous company in 10 minutes. Free plan includes 1 company and 10 runs/month.</p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/login" className="btn-primary" style={{ textDecoration: "none" }} onClick={() => sounds.click()}>Get Started Free</Link>
            <Link href="/pricing" className="btn-ghost" style={{ textDecoration: "none" }}>View Pricing</Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Authenticated dashboard ──
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in mesh-bg">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8" style={{ position: "relative", zIndex: 1 }}>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-headline gradient-text">Command Center</h1>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>Monitor your AI companies in real-time</p>
        </div>
        <Link
          href="/companies/new"
          className="btn-primary self-start sm:self-auto"
          style={{ textDecoration: "none" }}
          onClick={() => sounds.build()}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
          New Company
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8 stagger-children" style={{ position: "relative", zIndex: 1 }}>
        <MetricCard label="Active Companies" value={health?.activeCompanies ?? 0} icon="business" iconColor="#a4e6ff" loaded={loaded} />
        <MetricCard label="Running Pipelines" value={health?.activeRuns ?? 0} icon="play_circle" iconColor="#34d399" pulse={!!health?.activeRuns} loaded={loaded} />
        <MetricCard label="Pending Approvals" value={health?.pendingApprovals ?? 0} icon="task_alt" iconColor="#fbbf24" subtitle={(health?.pendingApprovals ?? 0) > 0 ? "Action needed" : undefined} loaded={loaded} />
        <MetricCard label="Total Runs" value={usage?.totalRuns ?? 0} icon="bolt" iconColor="#fbbf24" subtitle={usage ? `${(usage.successRate * 100).toFixed(0)}% success` : undefined} loaded={loaded} />
        <MetricCard label="Total Cost" value={`$${(finance?.totalCostUsd ?? 0).toFixed(2)}`} icon="payments" iconColor="#c084fc" subtitle={finance?.runCount ? `$${finance.avgCostPerRun.toFixed(4)}/run` : undefined} loaded={loaded} />
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" style={{ position: "relative", zIndex: 1 }}>
        {/* Companies */}
        <div className="lg:col-span-2">
          <div className="glass-card">
            <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <h2 className="font-semibold font-headline" style={{ color: "#e1e2eb" }}>Your Companies</h2>
              <Link href="/companies" className="text-xs font-medium transition-colors" style={{ color: "#a4e6ff", textDecoration: "none" }}
                onMouseEnter={(e) => e.currentTarget.style.color = "#00d1ff"}
                onMouseLeave={(e) => e.currentTarget.style.color = "#a4e6ff"}
              >
                View all
              </Link>
            </div>
            <div className="p-4">
              {!loaded ? (
                <div className="space-y-3">
                  {[1,2,3].map(i => (
                    <div key={i} className="h-16 rounded-xl animate-shimmer" />
                  ))}
                </div>
              ) : companies.length === 0 ? (
                <EmptyState title="No companies yet" description="Create your first AI company to start automating" actionHref="/companies/new" actionLabel="Create Company" />
              ) : (
                <div className="space-y-1 stagger-children">
                  {companies.slice(0, 5).map((c) => (
                    <CompanyRow key={c.id} company={c} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="lg:col-span-1">
          <ActivityFeed token={token} loaded={loaded} />
        </div>
      </div>

      {/* Pending Approvals Banner */}
      {(health?.pendingApprovals ?? 0) > 0 && (
        <Link
          href="/approvals"
          className="mt-6 flex items-center justify-between rounded-2xl px-5 py-4 animate-slide-up"
          style={{
            background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.15)",
            textDecoration: "none", transition: "all 0.3s", position: "relative", zIndex: 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(251,191,36,0.3)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(251,191,36,0.15)"; e.currentTarget.style.transform = "translateY(0)"; }}
          onClick={() => sounds.notify()}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(251,191,36,0.12)" }}>
              <span className="text-sm font-bold" style={{ color: "#fbbf24" }}>{health?.pendingApprovals}</span>
            </div>
            <div>
              <p className="font-semibold text-sm" style={{ color: "#fde68a" }}>Pending Approvals</p>
              <p className="text-xs" style={{ color: "#f59e0b" }}>Actions waiting for your review</p>
            </div>
          </div>
          <span className="text-xs font-medium" style={{ color: "#fbbf24" }}>Review &rarr;</span>
        </Link>
      )}
    </div>
  );
}

/* ─── Sub Components ─────────────────────────────────────── */

function MetricCard({ label, value, icon, iconColor, subtitle, pulse, loaded }: {
  label: string; value: string | number; icon: string; iconColor: string; subtitle?: string; pulse?: boolean; loaded?: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="flex items-center justify-between mb-3">
        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center" style={{ background: `${iconColor}08` }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18, color: iconColor }}>{icon}</span>
        </div>
        {pulse && (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: "#34d399" }} />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ background: "#10b981" }} />
          </span>
        )}
      </div>
      {loaded === false ? (
        <div className="h-7 w-16 rounded animate-shimmer mb-1" />
      ) : (
        <p className="text-lg sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>{value}</p>
      )}
      <p className="text-[10px] sm:text-xs mt-0.5" style={{ color: "#859399" }}>{label}</p>
      {subtitle && <p className="text-[11px] mt-1" style={{ color: "#3c494e" }}>{subtitle}</p>}
    </div>
  );
}

function CompanyRow({ company }: { company: any }) {
  const statusStyles: Record<string, { dot: string; color: string }> = {
    ACTIVE: { dot: "#10b981", color: "#34d399" },
    PAUSED: { dot: "#f59e0b", color: "#fbbf24" },
    DRAFT: { dot: "#859399", color: "#bbc9cf" },
    ARCHIVED: { dot: "#ef4444", color: "#f87171" },
  };
  const s = statusStyles[company.status] ?? statusStyles.DRAFT;

  return (
    <Link
      href={`/companies/${company.id}`}
      className="interactive-row flex items-center gap-4 px-4 py-3.5"
      style={{ color: "inherit", textDecoration: "none" }}
      onClick={() => sounds.click()}
    >
      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0 gradient-brand" style={{ boxShadow: "0 4px 12px rgba(0,209,255,0.12)" }}>
        {company.name?.charAt(0) ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-sm truncate" style={{ color: "#e1e2eb" }}>{company.name}</p>
          <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: s.color }}>
            <span className="status-dot" style={{ background: s.dot, width: 5, height: 5 }} />
            {company.status}
          </span>
        </div>
        <p className="text-xs truncate mt-0.5" style={{ color: "#859399" }}>{company.description ?? "No description"}</p>
      </div>
      <div className="hidden sm:flex gap-1 shrink-0">
        {company.primitives?.slice(0, 3).map((p: string) => (
          <span key={p} className="text-[10px] px-2 py-0.5 rounded-md font-medium" style={{ background: "rgba(0,209,255,0.06)", color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.12)" }}>
            {p}
          </span>
        ))}
        {(company.primitives?.length ?? 0) > 3 && (
          <span className="text-[10px]" style={{ color: "#859399" }}>+{company.primitives.length - 3}</span>
        )}
      </div>
      <span className="material-symbols-outlined text-base shrink-0" style={{ color: "#3c494e", transition: "transform 0.2s, color 0.2s" }}>chevron_right</span>
    </Link>
  );
}

function ActivityFeed({ token, loaded }: { token: string; loaded: boolean }) {
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    api.activityLog(token, 15, 0).then((data) => setLogs(data.logs ?? [])).catch(() => {});
  }, [token]);

  const actionColors: Record<string, string> = {
    "auth.register": "#a4e6ff", "auth.login": "#bbc9cf",
    "auth.google_register": "#a4e6ff", "auth.google_login": "#bbc9cf",
    "company.build": "#34d399", "company.build_start": "#60a5fa",
    "company.create": "#34d399", "run.start": "#60a5fa",
    "run.stop": "#f87171", "draft.create": "#c084fc",
    "draft.publish": "#34d399", "billing.checkout_started": "#fbbf24",
    "integration.save": "#a855f7",
  };

  return (
    <div className="glass-card">
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <h2 className="font-semibold font-headline" style={{ color: "#e1e2eb" }}>Activity</h2>
        <span className="status-dot" style={{ background: "#34d399", width: 5, height: 5 }} />
      </div>
      <div className="p-4">
        {!loaded ? (
          <div className="space-y-3">
            {[1,2,3,4,5].map(i => <div key={i} className="h-10 rounded-lg animate-shimmer" />)}
          </div>
        ) : logs.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: "#3c494e" }}>No recent activity</p>
        ) : (
          <div className="space-y-1 stagger-children">
            {logs.map((log: any) => {
              const color = actionColors[log.action] ?? "#859399";
              return (
                <div key={log.id} className="interactive-row flex items-start gap-3 px-2 py-2.5">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: `${color}0a`, border: "1px solid rgba(255,255,255,0.04)" }}>
                    <span className="text-[10px] font-bold" style={{ color }}>{(log.actor ?? "system").charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color }}>{log.action.replace(/\./g, " / ")}</p>
                    <p className="text-[11px] mt-0.5" style={{ color: "#3c494e" }}>{timeAgo(log.createdAt)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, description, actionHref, actionLabel }: {
  title: string; description: string; actionHref: string; actionLabel: string;
}) {
  return (
    <div className="text-center py-12 animate-fade-in">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 animate-float" style={{ background: "rgba(0,209,255,0.06)", border: "1px solid rgba(0,209,255,0.12)" }}>
        <span className="material-symbols-outlined text-2xl" style={{ color: "#a4e6ff" }}>business</span>
      </div>
      <p className="font-semibold text-sm" style={{ color: "#bbc9cf" }}>{title}</p>
      <p className="text-xs mt-1 mb-4" style={{ color: "#859399" }}>{description}</p>
      <Link href={actionHref} className="btn-primary" style={{ textDecoration: "none" }} onClick={() => sounds.build()}>
        <span className="material-symbols-outlined text-sm">add</span>
        {actionLabel}
      </Link>
    </div>
  );
}

