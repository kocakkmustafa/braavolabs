"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

const STATUS_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  active:   { bg: "rgba(52,211,153,0.1)",  color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" },
  paused:   { bg: "rgba(251,191,36,0.1)",  color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
  disabled: { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" },
};

const TRIGGER_ICONS: Record<string, string> = {
  manual: "touch_app",
  cron: "schedule",
  webhook: "webhook",
  event: "bolt",
};

export default function PipelinesPage() {
  const { token, hydrated } = useAuthGuard();
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCompany, setFilterCompany] = useState<string>("all");
  const [triggerLoading, setTriggerLoading] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!hydrated || !token) return;
    Promise.all([
      api.listCompanies(token).catch(() => []),
      api.listPipelines(token).catch(() => []),
    ]).then(([comps, pipes]) => {
      setCompanies(comps);
      setPipelines(pipes);
      setLoading(false);
    });
  }, [token, hydrated]);

  async function handleTrigger(pipelineId: string) {
    if (!token) return;
    setTriggerLoading(pipelineId);
    try {
      await api.triggerRun(token, pipelineId);
      const updated = await api.listPipelines(token).catch(() => []);
      setPipelines(updated);
    } catch {
      // silently handle
    }
    setTriggerLoading(null);
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  const filtered = pipelines.filter((p) => {
    if (filterCompany !== "all" && p.companyId !== filterCompany) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const stats = {
    total: pipelines.length,
    active: pipelines.filter((p) => p.status === "active").length,
    scheduled: pipelines.filter((p) => p.schedule).length,
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>AI Workflows</h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>Manage pipelines across all your companies</p>
        </div>
        <Link
          href="/companies/new"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white self-start sm:self-auto"
          style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
          New Company
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Total Pipelines", value: stats.total, icon: "account_tree", color: "#a4e6ff" },
          { label: "Active", value: stats.active, icon: "play_circle", color: "#34d399" },
          { label: "Scheduled", value: stats.scheduled, icon: "schedule", color: "#fbbf24" },
        ].map((s) => (
          <div key={s.label} className="glass-panel rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: s.color }}>{s.icon}</span>
              <span className="text-xs" style={{ color: "#859399" }}>{s.label}</span>
            </div>
            <span className="font-headline font-bold text-xl" style={{ color: "#e1e2eb" }}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2" style={{ fontSize: 18, color: "#3c494e" }}>search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search pipelines..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
          />
        </div>
        <select
          value={filterCompany}
          onChange={(e) => setFilterCompany(e.target.value)}
          className="px-4 py-2.5 rounded-xl text-sm outline-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
        >
          <option value="all">All Companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Pipeline list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-panel rounded-xl h-20 animate-shimmer" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-panel rounded-2xl text-center py-16">
          <span className="material-symbols-outlined text-4xl mb-4 block" style={{ color: "#00d1ff" }}>account_tree</span>
          <p className="font-semibold" style={{ color: "#e1e2eb" }}>
            {pipelines.length === 0 ? "No workflows yet" : "No matching workflows"}
          </p>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>
            {pipelines.length === 0 ? "Create a company to generate AI workflows automatically." : "Try adjusting your filters."}
          </p>
          {pipelines.length === 0 && (
            <Link
              href="/companies/new"
              className="inline-flex items-center gap-2 mt-5 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
              style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
            >
              Create Company
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((pipeline) => {
            const st = STATUS_COLORS[pipeline.status] ?? STATUS_COLORS.disabled;
            const trigger = pipeline.trigger ?? "manual";
            const companyName = companies.find((c) => c.id === pipeline.companyId)?.name ?? "—";
            const lastRun = pipeline.runs?.[0];

            return (
              <div
                key={pipeline.id}
                className="glass-panel rounded-xl p-4 sm:p-5 transition-all"
                style={{ borderLeft: `3px solid ${st.color}` }}
              >
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                  {/* Left: icon + name */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.15)" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#00d1ff" }}>account_tree</span>
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/companies/${pipeline.companyId}`}
                        className="font-semibold text-sm hover:underline block truncate"
                        style={{ color: "#e1e2eb", textDecoration: "none" }}
                      >
                        {pipeline.name}
                      </Link>
                      <p className="text-xs truncate" style={{ color: "#859399" }}>{companyName}</p>
                    </div>
                  </div>

                  {/* Middle: metadata */}
                  <div className="flex items-center gap-4 flex-wrap">
                    {/* Status */}
                    <span
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold"
                      style={{ background: st.bg, color: st.color, border: st.border }}
                    >
                      {pipeline.status?.toUpperCase() ?? "ACTIVE"}
                    </span>

                    {/* Trigger */}
                    <div className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#859399" }}>
                        {TRIGGER_ICONS[trigger] ?? "touch_app"}
                      </span>
                      <span className="text-xs" style={{ color: "#859399" }}>
                        {trigger === "cron" && pipeline.schedule ? pipeline.schedule : trigger}
                      </span>
                    </div>

                    {/* Steps count */}
                    <div className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#3c494e" }}>layers</span>
                      <span className="text-xs" style={{ color: "#3c494e" }}>{pipeline.steps?.length ?? 0} steps</span>
                    </div>

                    {/* Last run */}
                    {lastRun && (
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{
                            background: lastRun.status === "COMPLETED" ? "#34d399" : lastRun.status === "FAILED" ? "#f87171" : "#fbbf24",
                          }}
                        />
                        <span className="text-xs" style={{ color: "#859399" }}>
                          {timeAgo(lastRun.createdAt)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Right: actions */}
                  <div className="flex items-center gap-2 sm:flex-shrink-0">
                    <button
                      onClick={() => handleTrigger(pipeline.id)}
                      disabled={triggerLoading === pipeline.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                      style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)", color: "white" }}
                    >
                      {triggerLoading === pipeline.id ? (
                        <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                      )}
                      Run
                    </button>
                    <Link
                      href={`/companies/${pipeline.companyId}`}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf", textDecoration: "none" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
                      Detail
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
