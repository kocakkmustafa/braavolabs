"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

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
  const token = useAppStore((s) => s.token);
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
    api.usage(token).then(setUsage).catch(() => {});
    api.finance(token).then(setFinance).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token) return;
    api.listRuns(token, PAGE_SIZE, page * PAGE_SIZE).then((res) => {
      setRuns(res.runs);
      setTotal(res.total);
    }).catch(() => {});
  }, [token, page]);

  async function viewRun(id: string) {
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

  if (!token) return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: "#10131a" }}>
      <p className="text-sm" style={{ color: "#859399" }}>Please <a href="/login" style={{ color: "#00d1ff" }}>login</a> first.</p>
    </div>
  );

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Analytics</h1>
        <p className="text-sm mt-0.5" style={{ color: "#859399" }}>Pipeline run performance and cost breakdown</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <SummaryCard label="TOTAL RUNS" value={usage?.totalRuns ?? "—"} />
        <SummaryCard label="SUCCESS RATE" value={usage ? `${(usage.successRate * 100).toFixed(1)}%` : "—"} />
        <SummaryCard label="TOTAL COST" value={finance ? `$${finance.totalCostUsd.toFixed(2)}` : "—"} />
        <SummaryCard label="AVG/RUN" value={finance ? `$${finance.avgCostPerRun.toFixed(4)}` : "—"} />
      </div>

      {/* Run Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div
          className="rounded-2xl p-6"
          style={{ background: "rgba(29,32,38,0.7)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <h2 className="text-base font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>Run Breakdown (This Month)</h2>
          {usage ? (
            <div className="space-y-3">
              <BarRow label="Completed" count={usage.completedRuns} total={usage.totalRuns} color="#10b981" />
              <BarRow label="Failed" count={usage.failedRuns} total={usage.totalRuns} color="#ef4444" />
              <BarRow label="Other" count={usage.totalRuns - usage.completedRuns - usage.failedRuns} total={usage.totalRuns} color="#859399" />
            </div>
          ) : (
            <p className="text-sm" style={{ color: "#859399" }}>Loading...</p>
          )}
        </div>

        <div
          className="rounded-2xl p-6"
          style={{ background: "rgba(29,32,38,0.7)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <h2 className="text-base font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>Cost Summary (This Month)</h2>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center py-1">
                <span className="text-sm" style={{ color: "#859399" }}>Total Spent</span>
                <span className="font-semibold text-lg" style={{ color: "#e1e2eb" }}>${finance.totalCostUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center py-1" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <span className="text-sm" style={{ color: "#859399" }}>Billable Runs</span>
                <span className="font-semibold" style={{ color: "#bbc9cf" }}>{finance.runCount}</span>
              </div>
              <div className="flex justify-between items-center py-1" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <span className="text-sm" style={{ color: "#859399" }}>Average per Run</span>
                <span className="font-semibold" style={{ color: "#bbc9cf" }}>${finance.avgCostPerRun.toFixed(4)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "#859399" }}>Loading...</p>
          )}
        </div>
      </div>

      {/* Run History */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: "rgba(29,32,38,0.7)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <h2 className="text-base font-semibold font-headline" style={{ color: "#e1e2eb" }}>Run History</h2>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "#859399" }}>No runs found.</div>
        ) : (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <tr>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>COMPANY</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>PIPELINE</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>STATUS</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>STEPS</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>COST</th>
                    <th className="text-left px-6 py-3 text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>STARTED</th>
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
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1 rounded-lg text-sm transition-colors disabled:opacity-50"
                    style={{ border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf", background: "transparent" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-3 py-1 rounded-lg text-sm transition-colors disabled:opacity-50"
                    style={{ border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf", background: "transparent" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    Next
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

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="rounded-2xl p-5 min-w-0"
      style={{ background: "rgba(29,32,38,0.7)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <p className="text-xs font-semibold tracking-widest truncate" style={{ color: "#859399" }}>{label}</p>
      <p className="text-xl font-bold mt-1" style={{ color: "#e1e2eb" }}>{value}</p>
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

function RunRow({ run, expanded, detail, onToggle }: {
  run: any; expanded: boolean; detail: any; onToggle: () => void;
}) {
  const s = STATUS_STYLES[run.status] ?? defaultStatus;
  return (
    <>
      <tr
        className="cursor-pointer transition-colors"
        style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
        onClick={onToggle}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
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
              <p className="text-sm font-medium" style={{ color: "#bbc9cf" }}>Run Steps</p>
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
                      <p className="text-xs mt-1" style={{ color: "#3c494e" }}>Reasoning: {step.reasoning}</p>
                    )}
                    {step.toolCalls?.length > 0 && (
                      <p className="text-xs mt-1" style={{ color: "#3c494e" }}>{step.toolCalls.length} tool call(s)</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-xs" style={{ color: "#859399" }}>No steps recorded.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
