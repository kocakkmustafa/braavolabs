"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

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
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [companies, setCompanies] = useState<any[]>([]);

  useEffect(() => {
    if (!token) {
      router.push("/login");
      return;
    }
    Promise.all([
      api.health(token).then(setHealth).catch(() => {}),
      api.usage(token).then(setUsage).catch(() => {}),
      api.finance(token).then(setFinance).catch(() => {}),
      api.listCompanies(token).then(setCompanies).catch(() => {}),
    ]);
  }, [token, router]);

  if (!token) return null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1
            className="text-2xl font-bold font-headline"
            style={{ color: "#e1e2eb" }}
          >
            Command Center
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>
            Monitor your AI companies in real-time
          </p>
        </div>
        <a
          href="/companies/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
          style={{
            background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
            boxShadow: "0 0 20px rgba(0,209,255,0.2)",
          }}
        >
          <span className="material-symbols-outlined text-base">add</span>
          New Company
        </a>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <MetricCard
          label="Active Companies"
          value={health?.activeCompanies ?? 0}
          icon="business"
          iconColor="#a4e6ff"
        />
        <MetricCard
          label="Running Pipelines"
          value={health?.activeRuns ?? 0}
          icon="play_circle"
          iconColor="#34d399"
          pulse={!!health?.activeRuns}
        />
        <MetricCard
          label="Pending Approvals"
          value={health?.pendingApprovals ?? 0}
          icon="task_alt"
          iconColor="#fbbf24"
          subtitle={(health?.pendingApprovals ?? 0) > 0 ? "Action needed" : undefined}
        />
        <MetricCard
          label="Total Runs"
          value={usage?.totalRuns ?? 0}
          icon="bolt"
          iconColor="#fbbf24"
          subtitle={usage ? `${(usage.successRate * 100).toFixed(0)}% success` : undefined}
        />
        <MetricCard
          label="Total Cost"
          value={`$${(finance?.totalCostUsd ?? 0).toFixed(2)}`}
          icon="payments"
          iconColor="#c084fc"
          subtitle={finance?.runCount ? `$${finance.avgCostPerRun.toFixed(4)}/run` : undefined}
        />
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Companies — takes 2 cols */}
        <div className="lg:col-span-2">
          <div className="glass-panel rounded-2xl">
            <div
              className="px-6 py-4 flex items-center justify-between"
              style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
            >
              <h2 className="font-semibold font-headline" style={{ color: "#e1e2eb" }}>
                Your Companies
              </h2>
              <a
                href="/companies"
                className="text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: "#a4e6ff" }}
              >
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
                <div className="space-y-1">
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
          className="mt-6 flex items-center justify-between rounded-2xl px-6 py-4 transition-all hover:opacity-90"
          style={{
            background: "rgba(251,191,36,0.08)",
            border: "1px solid rgba(251,191,36,0.2)",
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: "rgba(251,191,36,0.15)" }}
            >
              <span className="text-sm font-bold" style={{ color: "#fbbf24" }}>
                {health?.pendingApprovals}
              </span>
            </div>
            <div>
              <p className="font-semibold text-sm" style={{ color: "#fde68a" }}>
                Pending Approvals
              </p>
              <p className="text-xs" style={{ color: "#f59e0b" }}>
                Actions waiting for your review
              </p>
            </div>
          </div>
          <span className="text-xs font-medium" style={{ color: "#fbbf24" }}>
            Review &rarr;
          </span>
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
  iconColor,
  subtitle,
  pulse,
}: {
  label: string;
  value: string | number;
  icon: string;
  iconColor: string;
  subtitle?: string;
  pulse?: boolean;
}) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          <span className="material-symbols-outlined text-lg" style={{ color: iconColor }}>
            {icon}
          </span>
        </div>
        {pulse && (
          <span className="relative flex h-2.5 w-2.5">
            <span
              className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
              style={{ background: "#34d399" }}
            />
            <span
              className="relative inline-flex rounded-full h-2.5 w-2.5"
              style={{ background: "#10b981" }}
            />
          </span>
        )}
      </div>
      <p className="text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>
        {value}
      </p>
      <p className="text-xs mt-0.5" style={{ color: "#859399" }}>
        {label}
      </p>
      {subtitle && (
        <p className="text-[11px] mt-1" style={{ color: "#3c494e" }}>
          {subtitle}
        </p>
      )}
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
    <a
      href={`/companies/${company.id}`}
      className="flex items-center gap-4 px-4 py-3.5 rounded-xl transition-colors group"
      style={{ color: "inherit" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shrink-0"
        style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
      >
        {company.name?.charAt(0) ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-sm truncate" style={{ color: "#e1e2eb" }}>
            {company.name}
          </p>
          <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: s.color }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />
            {company.status}
          </span>
        </div>
        <p className="text-xs truncate mt-0.5" style={{ color: "#859399" }}>
          {company.description ?? "No description"}
        </p>
      </div>
      <div className="flex gap-1 shrink-0">
        {company.primitives?.slice(0, 3).map((p: string) => (
          <span
            key={p}
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{
              background: "rgba(0,209,255,0.1)",
              color: "#a4e6ff",
              border: "1px solid rgba(0,209,255,0.2)",
            }}
          >
            {p}
          </span>
        ))}
        {(company.primitives?.length ?? 0) > 3 && (
          <span className="text-[10px]" style={{ color: "#859399" }}>
            +{company.primitives.length - 3}
          </span>
        )}
      </div>
      <span className="material-symbols-outlined text-base shrink-0" style={{ color: "#3c494e" }}>
        chevron_right
      </span>
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

  const actionColors: Record<string, string> = {
    "auth.register": "#a4e6ff",
    "auth.login": "#bbc9cf",
    "auth.google_register": "#a4e6ff",
    "auth.google_login": "#bbc9cf",
    "company.build": "#34d399",
    "company.build_start": "#60a5fa",
    "company.create": "#34d399",
    "run.start": "#60a5fa",
    "run.stop": "#f87171",
    "draft.create": "#c084fc",
    "draft.publish": "#34d399",
    "billing.checkout_started": "#fbbf24",
  };

  return (
    <div className="glass-panel rounded-2xl">
      <div
        className="px-6 py-4"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <h2 className="font-semibold font-headline" style={{ color: "#e1e2eb" }}>
          Activity
        </h2>
      </div>
      <div className="p-4">
        {logs.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: "#3c494e" }}>
            No recent activity
          </p>
        ) : (
          <div className="space-y-1">
            {logs.map((log: any) => {
              const color = actionColors[log.action] ?? "#859399";
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-3 px-2 py-2.5 rounded-lg transition-colors"
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{
                      background: `${color}14`,
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <span className="text-[10px] font-bold" style={{ color }}>
                      {(log.actor ?? "system").charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color }}>
                      {log.action.replace(/\./g, " / ")}
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: "#3c494e" }}>
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
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
        style={{
          background: "rgba(0,209,255,0.08)",
          border: "1px solid rgba(0,209,255,0.2)",
        }}
      >
        <span className="material-symbols-outlined text-2xl" style={{ color: "#a4e6ff" }}>
          business
        </span>
      </div>
      <p className="font-semibold text-sm" style={{ color: "#bbc9cf" }}>
        {title}
      </p>
      <p className="text-xs mt-1 mb-4" style={{ color: "#859399" }}>
        {description}
      </p>
      <a
        href={actionHref}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white"
        style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
      >
        <span className="material-symbols-outlined text-sm">add</span>
        {actionLabel}
      </a>
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
