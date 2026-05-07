"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  COMPLETED:        { bg: "rgba(52,211,153,0.1)",  color: "#34d399", border: "rgba(52,211,153,0.2)" },
  RUNNING:          { bg: "rgba(0,209,255,0.1)",   color: "#a4e6ff", border: "rgba(0,209,255,0.2)" },
  FAILED:           { bg: "rgba(239,68,68,0.1)",   color: "#f87171", border: "rgba(239,68,68,0.2)" },
  CANCELLED:        { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "rgba(133,147,153,0.2)" },
  PAUSED:           { bg: "rgba(251,191,36,0.1)",  color: "#fbbf24", border: "rgba(251,191,36,0.2)" },
  WAITING_APPROVAL: { bg: "rgba(251,146,60,0.1)",  color: "#fb923c", border: "rgba(251,146,60,0.2)" },
  QUEUED:           { bg: "rgba(109,17,173,0.15)", color: "#e0b6ff", border: "rgba(109,17,173,0.3)" },
};
const defaultStatus = { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "rgba(133,147,153,0.2)" };

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

export default function AnalyticsPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [runs, setRuns] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [page, setPage] = useState(0);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<any>(null);
  const PAGE_SIZE = 20;

  useEffect(() => {
    if (!token) return;
    api.usage(token).then(setUsage).catch(() => setUsage({ totalRuns: 0, completedRuns: 0, failedRuns: 0, successRate: 0 }));
    api.finance(token).then(setFinance).catch(() => setFinance({ totalCostUsd: 0, runCount: 0, avgCostPerRun: 0 }));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    api.listRuns(token, PAGE_SIZE, page * PAGE_SIZE).then((res) => {
      setRuns(res.runs);
      setTotal(res.total);
    }).catch(() => {});
  }, [token, page]);

  async function viewRun(id: string) {
    sounds.click();
    if (expandedRun === id) {
      setExpandedRun(null);
      setRunDetail(null);
      return;
    }
    setExpandedRun(id);
    try {
      const detail = await api.getRun(token!, id);
      setRunDetail(detail);
    } catch {
      setRunDetail(null);
    }
  }

  function exportCSV(data: any[]) {
    if (data.length === 0) return;
    sounds.success();
    const header = "Company,Pipeline,Status,Steps,Cost,Started\n";
    const rows = data.map((r) =>
      [
        r.pipeline?.company?.name ?? "",
        r.pipeline?.name ?? "",
        r.status,
        r._count?.steps ?? 0,
        r.costUsd ? Number(r.costUsd).toFixed(4) : "0",
        new Date(r.createdAt).toISOString(),
      ].join(",")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in mesh-bg">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-headline gradient-text">{t("app.analytics.title")}</h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>{t("app.analytics.subtitle")}</p>
        </div>
        <button
          onClick={() => exportCSV(runs)}
          className="btn-ghost inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium self-start sm:self-auto"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
          {t("app.analytics.exportCsv")}
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8 stagger-children">
        <div className="metric-card rounded-2xl p-5 min-w-0">
          <p className="text-xs font-semibold tracking-widest truncate" style={{ color: "#859399" }}>{t("app.analytics.statTotalRuns")}</p>
          <p className="text-xl font-bold font-headline mt-1" style={{ color: "#e1e2eb" }}>{usage?.totalRuns ?? "—"}</p>
        </div>
        <div className="metric-card rounded-2xl p-5 min-w-0">
          <p className="text-xs font-semibold tracking-widest truncate" style={{ color: "#859399" }}>{t("app.analytics.statSuccessRate")}</p>
          <p className="text-xl font-bold font-headline mt-1" style={{ color: "#34d399" }}>{usage ? `${(usage.successRate * 100).toFixed(1)}%` : "—"}</p>
        </div>
        <div className="metric-card rounded-2xl p-5 min-w-0">
          <p className="text-xs font-semibold tracking-widest truncate" style={{ color: "#859399" }}>{t("app.analytics.statTotalCost")}</p>
          <p className="text-xl font-bold font-headline mt-1" style={{ color: "#e1e2eb" }}>{finance ? `$${finance.totalCostUsd.toFixed(2)}` : "—"}</p>
        </div>
        <div className="metric-card rounded-2xl p-5 min-w-0">
          <p className="text-xs font-semibold tracking-widest truncate" style={{ color: "#859399" }}>{t("app.analytics.statAvgRun")}</p>
          <p className="text-xl font-bold font-headline mt-1" style={{ color: "#e1e2eb" }}>{finance ? `$${finance.avgCostPerRun.toFixed(4)}` : "—"}</p>
        </div>
      </div>

      {/* Run Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 stagger-children">
        <div className="glass-card rounded-2xl p-6">
          <h2 className="text-base font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>{t("app.analytics.runBreakdown")}</h2>
          {usage ? (
            <div className="flex items-center gap-6">
              <DonutChart
                segments={[
                  { value: usage.completedRuns, color: "#10b981", label: t("app.analytics.barCompleted") },
                  { value: usage.failedRuns, color: "#ef4444", label: t("app.analytics.barFailed") },
                  { value: Math.max(0, usage.totalRuns - usage.completedRuns - usage.failedRuns), color: "#859399", label: t("app.analytics.barOther") },
                ]}
                total={usage.totalRuns}
                runsLabel={t("app.analytics.donutLabel")}
              />
              <div className="space-y-3 flex-1">
                <BarRow label={t("app.analytics.barCompleted")} count={usage.completedRuns} total={usage.totalRuns} color="#10b981" />
                <BarRow label={t("app.analytics.barFailed")} count={usage.failedRuns} total={usage.totalRuns} color="#ef4444" />
                <BarRow label={t("app.analytics.barOther")} count={usage.totalRuns - usage.completedRuns - usage.failedRuns} total={usage.totalRuns} color="#859399" />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32">
              <div className="w-8 h-8 rounded-full border-2 animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
            </div>
          )}
        </div>

        <div className="glass-card rounded-2xl p-6">
          <h2 className="text-base font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>{t("app.analytics.costSummary")}</h2>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center py-1">
                <span className="text-sm" style={{ color: "#859399" }}>{t("app.analytics.totalSpent")}</span>
                <span className="font-semibold text-lg gradient-text">${finance.totalCostUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center py-1" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <span className="text-sm" style={{ color: "#859399" }}>{t("app.analytics.billableRuns")}</span>
                <span className="font-semibold" style={{ color: "#bbc9cf" }}>{finance.runCount}</span>
              </div>
              <div className="flex justify-between items-center py-1" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <span className="text-sm" style={{ color: "#859399" }}>{t("app.analytics.averagePerRun")}</span>
                <span className="font-semibold" style={{ color: "#bbc9cf" }}>${finance.avgCostPerRun.toFixed(4)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "#859399" }}>{t("app.analytics.loading")}</p>
          )}
        </div>
      </div>

      {/* Run History */}
      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <h2 className="text-base font-semibold font-headline" style={{ color: "#e1e2eb" }}>{t("app.analytics.runHistory")}</h2>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "#859399" }}>{t("app.analytics.noRuns")}</div>
        ) : (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <tr>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{t("app.analytics.thCompany")}</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{t("app.analytics.thPipeline")}</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{t("app.analytics.thStatus")}</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{t("app.analytics.thSteps")}</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{t("app.analytics.thCost")}</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{t("app.analytics.thStarted")}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      expanded={expandedRun === r.id}
                      detail={expandedRun === r.id ? runDetail : null}
                      onToggle={() => viewRun(r.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                className="flex items-center justify-between px-6 py-3"
                style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
              >
                <span className="text-sm" style={{ color: "#859399" }}>
                  {t("app.analytics.showingRange", { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, total), total })}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => { sounds.click(); setPage((p) => Math.max(0, p - 1)); }}
                    disabled={page === 0}
                    className="btn-ghost px-3 py-1 rounded-lg text-sm disabled:opacity-50"
                  >
                    {t("app.analytics.prev")}
                  </button>
                  <button
                    onClick={() => { sounds.click(); setPage((p) => Math.min(totalPages - 1, p + 1)); }}
                    disabled={page >= totalPages - 1}
                    className="btn-ghost px-3 py-1 rounded-lg text-sm disabled:opacity-50"
                  >
                    {t("app.analytics.next")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BarRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span style={{ color: "#859399" }}>{label}</span>
        <span className="font-medium" style={{ color: "#bbc9cf" }}>{count}</span>
      </div>
      <div className="w-full rounded-full h-2" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function DonutChart({ segments, total, runsLabel }: { segments: { value: number; color: string; label: string }[]; total: number; runsLabel?: string }) {
  const size = 100;
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((seg) => {
      const pct = total > 0 ? seg.value / total : 0;
      const dashLen = pct * circumference;
      const dashOffset = -offset;
      offset += dashLen;
      return { ...seg, dashLen, dashOffset, pct };
    });

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth}
        />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={arc.color} strokeWidth={strokeWidth}
            strokeDasharray={`${arc.dashLen} ${circumference - arc.dashLen}`}
            strokeDashoffset={arc.dashOffset}
            strokeLinecap="round"
            style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dasharray 0.5s ease" }}
          />
        ))}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span className="font-headline font-bold text-lg" style={{ color: "#e1e2eb", lineHeight: 1 }}>{total}</span>
        <span style={{ fontSize: 9, color: "#3c494e" }}>{runsLabel ?? "runs"}</span>
      </div>
    </div>
  );
}

function RunRow({ run, expanded, detail, onToggle }: {
  run: any; expanded: boolean; detail: any; onToggle: () => void;
}) {
  const t = useTranslations();
  const s = STATUS_STYLES[run.status] ?? defaultStatus;
  return (
    <>
      <tr
        className="interactive-row cursor-pointer"
        style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
        onClick={onToggle}
      >
        <td className="px-6 py-3" style={{ color: "#bbc9cf" }}>{run.pipeline?.company?.name ?? "—"}</td>
        <td className="px-6 py-3" style={{ color: "#bbc9cf" }}>{run.pipeline?.name ?? "—"}</td>
        <td className="px-6 py-3">
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
          >
            {run.status}
          </span>
        </td>
        <td className="px-6 py-3" style={{ color: "#859399" }}>{run._count?.steps ?? 0}</td>
        <td className="px-6 py-3" style={{ color: "#859399" }}>{run.costUsd ? `$${Number(run.costUsd).toFixed(4)}` : "—"}</td>
        <td className="px-6 py-3" style={{ color: "#3c494e" }}>{new Date(run.createdAt).toLocaleString()}</td>
      </tr>
      {expanded && detail && (
        <tr>
          <td colSpan={6} className="px-6 py-4" style={{ background: "rgba(255,255,255,0.02)" }}>
            <div className="space-y-2">
              <p className="text-sm font-medium" style={{ color: "#bbc9cf" }}>{t("app.analytics.runSteps")}</p>
              {detail.steps?.length > 0 ? (
                detail.steps.map((step: any, i: number) => (
                  <div
                    key={step.id}
                    className="rounded-xl p-3 text-sm"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="font-mono text-xs px-1.5 py-0.5 rounded"
                        style={{ background: "rgba(255,255,255,0.06)", color: "#859399" }}
                      >
                        #{i + 1}
                      </span>
                      <span className="font-medium" style={{ color: "#bbc9cf" }}>{step.stepName}</span>
                      {(() => {
                        const ss = STATUS_STYLES[step.status] ?? defaultStatus;
                        return (
                          <span
                            className="text-xs px-2 py-0.5 rounded-full"
                            style={{ background: ss.bg, color: ss.color, border: `1px solid ${ss.border}` }}
                          >
                            {step.status}
                          </span>
                        );
                      })()}
                    </div>
                    {step.reasoning && (
                      <p className="text-xs mt-1" style={{ color: "#3c494e" }}>{t("app.analytics.reasoningPrefix")} {step.reasoning}</p>
                    )}
                    {step.toolCalls?.length > 0 && (
                      <p className="text-xs mt-1" style={{ color: "#3c494e" }}>{t("app.analytics.toolCallsTemplate", { count: step.toolCalls.length })}</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-xs" style={{ color: "#859399" }}>{t("app.analytics.noSteps")}</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
