"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  RUNNING: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  FAILED: "bg-red-500/10 text-red-400 border-red-500/20",
  CANCELLED: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  PAUSED: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  WAITING_APPROVAL: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  QUEUED: "bg-purple-500/10 text-purple-400 border-purple-500/20",
};

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

  if (!token) return <p className="text-slate-500 p-8">Please login first.</p>;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">Analytics</h1>
        <p className="text-sm text-slate-500 mt-0.5">Pipeline run performance and cost breakdown</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <SummaryCard label="Total Runs" value={usage?.totalRuns ?? "—"} />
        <SummaryCard label="Success Rate" value={usage ? `${(usage.successRate * 100).toFixed(1)}%` : "—"} />
        <SummaryCard label="Total Cost" value={finance ? `$${finance.totalCostUsd.toFixed(2)}` : "—"} />
        <SummaryCard label="Avg Cost/Run" value={finance ? `$${finance.avgCostPerRun.toFixed(4)}` : "—"} />
      </div>

      {/* Run Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="card-glass p-6">
          <h2 className="text-base font-semibold text-slate-200 mb-4">Run Breakdown (This Month)</h2>
          {usage ? (
            <div className="space-y-3">
              <BarRow label="Completed" count={usage.completedRuns} total={usage.totalRuns} color="bg-emerald-500" />
              <BarRow label="Failed" count={usage.failedRuns} total={usage.totalRuns} color="bg-red-500" />
              <BarRow label="Other" count={usage.totalRuns - usage.completedRuns - usage.failedRuns} total={usage.totalRuns} color="bg-slate-500" />
            </div>
          ) : (
            <p className="text-slate-500 text-sm">Loading...</p>
          )}
        </div>

        <div className="card-glass p-6">
          <h2 className="text-base font-semibold text-slate-200 mb-4">Cost Summary (This Month)</h2>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-500 text-sm">Total Spent</span>
                <span className="font-semibold text-lg text-slate-100">${finance.totalCostUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-500 text-sm">Billable Runs</span>
                <span className="font-semibold text-slate-200">{finance.runCount}</span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-500 text-sm">Average per Run</span>
                <span className="font-semibold text-slate-200">${finance.avgCostPerRun.toFixed(4)}</span>
              </div>
            </div>
          ) : (
            <p className="text-slate-500 text-sm">Loading...</p>
          )}
        </div>
      </div>

      {/* Run History */}
      <div className="card-glass overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-slate-200">Run History</h2>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-slate-500">No runs found.</div>
        ) : (
          <div>
            <table className="w-full text-sm">
              <thead className="border-b border-white/[0.06]">
                <tr>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Company</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Pipeline</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Status</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Steps</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Cost</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Started</th>
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

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-white/[0.06]">
                <span className="text-sm text-slate-500">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1 border border-white/[0.08] rounded-lg text-sm text-slate-400 disabled:opacity-50 hover:bg-white/[0.04] transition-colors"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-3 py-1 border border-white/[0.08] rounded-lg text-sm text-slate-400 disabled:opacity-50 hover:bg-white/[0.04] transition-colors"
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
    <div className="card-glass p-5">
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-slate-100 mt-1">{value}</p>
    </div>
  );
}

function BarRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-slate-400">{label}</span>
        <span className="font-medium text-slate-300">{count}</span>
      </div>
      <div className="w-full bg-white/[0.06] rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RunRow({ run, expanded, detail, onToggle }: {
  run: any; expanded: boolean; detail: any; onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="border-t border-white/[0.04] hover:bg-white/[0.02] cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-6 py-3 text-slate-300">{run.pipeline?.company?.name ?? "—"}</td>
        <td className="px-6 py-3 text-slate-300">{run.pipeline?.name ?? "—"}</td>
        <td className="px-6 py-3">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLORS[run.status] ?? ""}`}>
            {run.status}
          </span>
        </td>
        <td className="px-6 py-3 text-slate-400">{run._count?.steps ?? 0}</td>
        <td className="px-6 py-3 text-slate-400">{run.costUsd ? `$${Number(run.costUsd).toFixed(4)}` : "—"}</td>
        <td className="px-6 py-3 text-slate-500">{new Date(run.createdAt).toLocaleString()}</td>
      </tr>
      {expanded && detail && (
        <tr>
          <td colSpan={6} className="px-6 py-4 bg-white/[0.02]">
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">Run Steps</p>
              {detail.steps?.length > 0 ? (
                detail.steps.map((step: any, i: number) => (
                  <div key={step.id} className="bg-white/[0.04] rounded-lg p-3 border border-white/[0.06] text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs bg-white/[0.06] text-slate-400 px-1.5 py-0.5 rounded">#{i + 1}</span>
                      <span className="font-medium text-slate-300">{step.stepName}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLORS[step.status] ?? ""}`}>
                        {step.status}
                      </span>
                    </div>
                    {step.reasoning && (
                      <p className="text-slate-500 text-xs mt-1">Reasoning: {step.reasoning}</p>
                    )}
                    {step.toolCalls?.length > 0 && (
                      <p className="text-slate-600 text-xs mt-1">{step.toolCalls.length} tool call(s)</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-slate-500 text-xs">No steps recorded.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
