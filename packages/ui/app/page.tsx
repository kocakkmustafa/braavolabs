"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../lib/store";

interface HealthData {
  activeCompanies: number;
  activeRuns: number;
  pendingApprovals: number;
}

interface UsageData {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  successRate: number;
}

interface FinanceData {
  totalCostUsd: number;
  runCount: number;
  avgCostPerRun: number;
}

export default function DashboardPage() {
  const token = useAppStore((s) => s.token);
  const setAuth = useAppStore((s) => s.setAuth);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [companies, setCompanies] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.health(token).then(setHealth).catch(() => {}),
      api.usage(token).then(setUsage).catch(() => {}),
      api.finance(token).then(setFinance).catch(() => {}),
      api.listCompanies(token).then(setCompanies).catch(() => {}),
    ]);
  }, [token]);

  if (!token) {
    return <LoginPrompt setAuth={setAuth} />;
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Monitor your AI companies in real-time</p>
        </div>
        <a
          href="/companies/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white gradient-brand shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 transition-all duration-200"
        >
          <PlusIcon />
          New Company
        </a>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard
          label="Active Companies"
          value={health?.activeCompanies ?? 0}
          icon={<BuildingMiniIcon className="text-brand-500" />}
          trend="active"
        />
        <MetricCard
          label="Running Pipelines"
          value={health?.activeRuns ?? 0}
          icon={<PlayMiniIcon className="text-emerald-500" />}
          trend="running"
        />
        <MetricCard
          label="Total Runs"
          value={usage?.totalRuns ?? 0}
          icon={<BoltMiniIcon className="text-amber-500" />}
          subtitle={usage ? `${(usage.successRate * 100).toFixed(0)}% success` : undefined}
        />
        <MetricCard
          label="Total Cost"
          value={`$${(finance?.totalCostUsd ?? 0).toFixed(2)}`}
          icon={<CurrencyMiniIcon className="text-violet-500" />}
          subtitle={finance?.runCount ? `$${finance.avgCostPerRun.toFixed(4)}/run` : undefined}
        />
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Companies — takes 2 cols */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">Your Companies</h2>
              <a href="/companies" className="text-xs font-medium text-brand-600 hover:text-brand-700">
                View all
              </a>
            </div>
            <div className="p-4">
              {companies.length === 0 ? (
                <EmptyState
                  title="No companies yet"
                  description="Create your first AI company to start automating"
                  actionHref="/companies/new"
                  actionLabel="Create Company"
                />
              ) : (
                <div className="space-y-2">
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
          <ActivityFeed token={token} />
        </div>
      </div>

      {/* Pending Approvals Banner */}
      {(health?.pendingApprovals ?? 0) > 0 && (
        <a
          href="/approvals"
          className="mt-6 flex items-center justify-between bg-amber-50 border border-amber-200 rounded-2xl px-6 py-4 hover:bg-amber-100 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
              <span className="text-amber-600 text-sm font-bold">{health?.pendingApprovals}</span>
            </div>
            <div>
              <p className="font-semibold text-amber-900 text-sm">Pending Approvals</p>
              <p className="text-xs text-amber-700">Actions waiting for your review</p>
            </div>
          </div>
          <span className="text-amber-600 text-xs font-medium">Review &rarr;</span>
        </a>
      )}
    </div>
  );
}

/* ─── Sub Components ─────────────────────────────────────── */

function MetricCard({
  label,
  value,
  icon,
  subtitle,
  trend,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  subtitle?: string;
  trend?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center">{icon}</div>
        {trend === "running" && (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
        )}
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
      {subtitle && <p className="text-[11px] text-slate-400 mt-1">{subtitle}</p>}
    </div>
  );
}

function CompanyRow({ company }: { company: any }) {
  const statusStyles: Record<string, { dot: string; text: string }> = {
    ACTIVE: { dot: "bg-emerald-500", text: "text-emerald-700" },
    PAUSED: { dot: "bg-amber-500", text: "text-amber-700" },
    DRAFT: { dot: "bg-slate-400", text: "text-slate-600" },
    ARCHIVED: { dot: "bg-red-400", text: "text-red-600" },
  };
  const s = statusStyles[company.status] ?? statusStyles.DRAFT;

  return (
    <a
      href={`/companies/${company.id}`}
      className="flex items-center gap-4 px-4 py-3.5 rounded-xl hover:bg-slate-50 transition-colors group"
    >
      <div className="w-10 h-10 rounded-xl gradient-brand flex items-center justify-center text-white font-bold text-sm shrink-0">
        {company.name?.charAt(0) ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-sm text-slate-900 truncate">{company.name}</p>
          <span className={`flex items-center gap-1 text-[11px] font-medium ${s.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
            {company.status}
          </span>
        </div>
        <p className="text-xs text-slate-500 truncate mt-0.5">{company.description ?? "No description"}</p>
      </div>
      <div className="flex gap-1 shrink-0">
        {company.primitives?.slice(0, 3).map((p: string) => (
          <span key={p} className="text-[10px] bg-brand-50 text-brand-600 px-1.5 py-0.5 rounded font-medium">
            {p}
          </span>
        ))}
        {(company.primitives?.length ?? 0) > 3 && (
          <span className="text-[10px] text-slate-400">+{company.primitives.length - 3}</span>
        )}
      </div>
      <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
      </svg>
    </a>
  );
}

function ActivityFeed({ token }: { token: string }) {
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    api.activityLog(token, 15, 0)
      .then((data) => setLogs(data.logs ?? []))
      .catch(() => {});
  }, [token]);

  const actionIcons: Record<string, { bg: string; color: string }> = {
    "auth.register": { bg: "bg-brand-50", color: "text-brand-600" },
    "auth.login": { bg: "bg-slate-100", color: "text-slate-600" },
    "auth.google_register": { bg: "bg-brand-50", color: "text-brand-600" },
    "auth.google_login": { bg: "bg-slate-100", color: "text-slate-600" },
    "company.build": { bg: "bg-emerald-50", color: "text-emerald-600" },
    "company.build_start": { bg: "bg-blue-50", color: "text-blue-600" },
    "company.create": { bg: "bg-emerald-50", color: "text-emerald-600" },
    "run.start": { bg: "bg-blue-50", color: "text-blue-600" },
    "run.stop": { bg: "bg-red-50", color: "text-red-600" },
    "draft.create": { bg: "bg-violet-50", color: "text-violet-600" },
    "draft.publish": { bg: "bg-emerald-50", color: "text-emerald-600" },
    "billing.checkout_started": { bg: "bg-amber-50", color: "text-amber-600" },
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm">
      <div className="px-6 py-4 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900">Activity</h2>
      </div>
      <div className="p-4">
        {logs.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">No recent activity</p>
        ) : (
          <div className="space-y-1">
            {logs.map((log: any) => {
              const style = actionIcons[log.action] ?? { bg: "bg-slate-100", color: "text-slate-500" };
              return (
                <div key={log.id} className="flex items-start gap-3 px-2 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                  <div className={`w-7 h-7 rounded-lg ${style.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${style.color.replace("text-", "bg-")}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${style.color}`}>
                      {log.action.replace(/\./g, " / ")}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {timeAgo(log.createdAt)}
                    </p>
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

function EmptyState({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div className="text-center py-12">
      <div className="w-14 h-14 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-4">
        <BuildingMiniIcon className="text-brand-400 !w-7 !h-7" />
      </div>
      <p className="font-semibold text-slate-700 text-sm">{title}</p>
      <p className="text-xs text-slate-500 mt-1 mb-4">{description}</p>
      <a
        href={actionHref}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white gradient-brand"
      >
        <PlusIcon />
        {actionLabel}
      </a>
    </div>
  );
}

function LoginPrompt({ setAuth }: { setAuth: (t: string, id: string) => void }) {
  const [input, setInput] = useState("");

  return (
    <div className="flex items-center justify-center h-full bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 p-10 max-w-md w-full text-center border border-slate-200/60">
        <div className="w-16 h-16 rounded-2xl gradient-brand flex items-center justify-center mx-auto mb-6 shadow-lg shadow-brand-500/30">
          <span className="text-white font-bold text-xl">AI</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">AI Company OS</h1>
        <p className="text-slate-500 text-sm mt-2 mb-8">Build autonomous AI companies in minutes</p>
        <input
          type="text"
          placeholder="Paste JWT Token"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-full border border-slate-200 rounded-xl px-4 py-3 mb-3 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
        />
        <button
          onClick={() => {
            if (!input.trim()) return;
            try {
              const payload = JSON.parse(atob(input.split(".")[1]));
              setAuth(input, payload.tenantId ?? "default");
            } catch {
              setAuth(input, "default");
            }
          }}
          className="w-full py-3 rounded-xl text-sm font-semibold text-white gradient-brand shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 transition-all"
        >
          Continue
        </button>
        <div className="flex items-center my-5">
          <div className="flex-1 border-t border-slate-100" />
          <span className="px-3 text-[11px] text-slate-400">or</span>
          <div className="flex-1 border-t border-slate-100" />
        </div>
        <a
          href="/login"
          className="block w-full py-3 rounded-xl text-sm font-semibold text-slate-700 border border-slate-200 hover:bg-slate-50 transition-colors"
        >
          Sign in with Email
        </a>
      </div>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────── */

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ─── Mini Icons ──────────────────────────────────────────── */

function PlusIcon() {
  return <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>;
}
function BuildingMiniIcon({ className = "" }: { className?: string }) {
  return <svg className={`w-5 h-5 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21" /></svg>;
}
function PlayMiniIcon({ className = "" }: { className?: string }) {
  return <svg className={`w-5 h-5 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" /></svg>;
}
function BoltMiniIcon({ className = "" }: { className?: string }) {
  return <svg className={`w-5 h-5 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" /></svg>;
}
function CurrencyMiniIcon({ className = "" }: { className?: string }) {
  return <svg className={`w-5 h-5 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>;
}
