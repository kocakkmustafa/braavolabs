"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  RUNNING: "bg-blue-100 text-blue-800",
  FAILED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
  PAUSED: "bg-yellow-100 text-yellow-800",
  WAITING_APPROVAL: "bg-orange-100 text-orange-800",
  QUEUED: "bg-purple-100 text-purple-800",
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

  if (!token) return <p className="text-gray-500">Please login first.</p>;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Analytics</h1>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <SummaryCard label="Total Runs" value={usage?.totalRuns ?? "—"} />
        <SummaryCard label="Success Rate" value={usage ? `${(usage.successRate * 100).toFixed(1)}%` : "—"} />
        <SummaryCard label="Total Cost" value={finance ? `$${finance.totalCostUsd.toFixed(2)}` : "—"} />
        <SummaryCard label="Avg Cost/Run" value={finance ? `$${finance.avgCostPerRun.toFixed(4)}` : "—"} />
      </div>

      {/* Run Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Run Breakdown (This Month)</h2>
          {usage ? (
            <div className="space-y-3">
              <BarRow label="Completed" count={usage.completedRuns} total={usage.totalRuns} color="bg-green-500" />
              <BarRow label="Failed" count={usage.failedRuns} total={usage.totalRuns} color="bg-red-500" />
              <BarRow label="Other" count={usage.totalRuns - usage.completedRuns - usage.failedRuns} total={usage.totalRuns} color="bg-gray-400" />
            </div>
          ) : (
            <p className="text-gray-500 text-sm">Loading...</p>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Cost Summary (This Month)</h2>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-500">Total Spent</span>
                <span className="font-semibold text-lg">${finance.totalCostUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Billable Runs</span>
                <span className="font-semibold">{finance.runCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Average per Run</span>
                <span className="font-semibold">${finance.avgCostPerRun.toFixed(4)}</span>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">Loading...</p>
          )}
        </div>
      </div>

      {/* Run History */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">Run History</h2>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-gray-500">No runs found.</div>
        ) : (
          <div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Company</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Pipeline</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Status</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Steps</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Cost</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Started</th>
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
              <div className="flex items-center justify-between px-6 py-3 border-t">
                <span className="text-sm text-gray-500">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1 border rounded text-sm disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-3 py-1 border rounded text-sm disabled:opacity-50"
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
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

function BarRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="font-medium">{count}</span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full`} style={{ width: `${pct}%` }} />
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
        className="border-t hover:bg-gray-50 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-6 py-3">{run.pipeline?.company?.name ?? "—"}</td>
        <td className="px-6 py-3">{run.pipeline?.name ?? "—"}</td>
        <td className="px-6 py-3">
          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[run.status] ?? ""}`}>
            {run.status}
          </span>
        </td>
        <td className="px-6 py-3">{run._count?.steps ?? 0}</td>
        <td className="px-6 py-3">{run.costUsd ? `$${Number(run.costUsd).toFixed(4)}` : "—"}</td>
        <td className="px-6 py-3 text-gray-500">{new Date(run.createdAt).toLocaleString()}</td>
      </tr>
      {expanded && detail && (
        <tr>
          <td colSpan={6} className="px-6 py-4 bg-gray-50">
            <div className="space-y-2">
              <p className="text-sm font-medium">Run Steps</p>
              {detail.steps?.length > 0 ? (
                detail.steps.map((step: any, i: number) => (
                  <div key={step.id} className="bg-white rounded p-3 border text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">#{i + 1}</span>
                      <span className="font-medium">{step.stepName}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[step.status] ?? ""}`}>
                        {step.status}
                      </span>
                    </div>
                    {step.reasoning && (
                      <p className="text-gray-600 text-xs mt-1">Reasoning: {step.reasoning}</p>
                    )}
                    {step.toolCalls?.length > 0 && (
                      <p className="text-gray-400 text-xs mt-1">{step.toolCalls.length} tool call(s)</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-xs">No steps recorded.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
