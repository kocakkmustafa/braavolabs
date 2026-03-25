"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const RISK_LABELS: Record<string, { label: string; color: string }> = {
  "governance.hard_stop": { label: "Hard Stop", color: "bg-red-500/10 text-red-400 border-red-500/20" },
  "governance.loop_stop": { label: "Loop Detected", color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  "governance.cost_anomaly_stop": { label: "Cost Anomaly", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  "governance.spam_stop": { label: "Spam Protection", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  "governance.brand_violation_stop": { label: "Brand Violation", color: "bg-pink-500/10 text-pink-400 border-pink-500/20" },
  "run.failed": { label: "Run Failed", color: "bg-red-500/10 text-red-400 border-red-500/20" },
  "run.stop": { label: "Run Stopped", color: "bg-slate-500/10 text-slate-400 border-slate-500/20" },
};

export default function RisksPage() {
  const token = useAppStore((s) => s.token);
  const [events, setEvents] = useState<any[]>([]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [tab, setTab] = useState<"risks" | "activity">("risks");

  useEffect(() => {
    if (!token) return;
    api.riskEvents(token).then(setEvents).catch(() => {});
    api.activityLog(token, 100).then((res) => setActivityLogs(res.logs)).catch(() => {});
  }, [token]);

  if (!token) return <p className="text-slate-500 p-8">Please login first.</p>;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">Risk Monitor</h1>
        <p className="text-sm text-slate-500 mt-0.5">Governance alerts and system activity</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="card-glass p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Total Risk Events</p>
          <p className="text-2xl font-bold text-red-400">{events.length}</p>
        </div>
        <div className="card-glass p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Loop Stops</p>
          <p className="text-2xl font-bold text-orange-400">
            {events.filter((e) => e.action === "governance.loop_stop").length}
          </p>
        </div>
        <div className="card-glass p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Cost Anomalies</p>
          <p className="text-2xl font-bold text-amber-400">
            {events.filter((e) => e.action === "governance.cost_anomaly_stop").length}
          </p>
        </div>
        <div className="card-glass p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Failed Runs</p>
          <p className="text-2xl font-bold text-slate-400">
            {events.filter((e) => e.action === "run.failed").length}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.08] mb-6">
        <button
          onClick={() => setTab("risks")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
            tab === "risks" ? "border-brand-500 text-brand-400" : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          Risk Events ({events.length})
        </button>
        <button
          onClick={() => setTab("activity")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
            tab === "activity" ? "border-brand-500 text-brand-400" : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          Activity Log ({activityLogs.length})
        </button>
      </div>

      {tab === "risks" ? (
        events.length === 0 ? (
          <div className="card-glass text-center py-16">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" /></svg>
            </div>
            <p className="font-semibold text-slate-300">All systems normal</p>
            <p className="text-sm text-slate-500 mt-1">No risk events detected.</p>
          </div>
        ) : (
          <div className="card-glass overflow-hidden">
            {events.map((e, i) => {
              const info = RISK_LABELS[e.action] ?? { label: e.action, color: "bg-slate-500/10 text-slate-400 border-slate-500/20" };
              return (
                <div key={e.id ?? i} className={`px-6 py-4 ${i > 0 ? "border-t border-white/[0.06]" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${info.color}`}>
                        {info.label}
                      </span>
                      <span className="text-sm text-slate-400">{e.resource}: {e.resourceId?.slice(0, 8) ?? "—"}</span>
                    </div>
                    <span className="text-xs text-slate-600">
                      {new Date(e.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {e.details && (
                    <p className="text-xs text-slate-500 mt-1">
                      {typeof e.details === "string" ? e.details : JSON.stringify(e.details)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        activityLogs.length === 0 ? (
          <div className="card-glass text-center py-16">
            <p className="text-slate-500">No activity recorded yet.</p>
          </div>
        ) : (
          <div className="card-glass overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-white/[0.06]">
                <tr>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Action</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Resource</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Actor</th>
                  <th className="text-left px-6 py-3 text-slate-500 font-medium text-xs uppercase tracking-wide">Time</th>
                </tr>
              </thead>
              <tbody>
                {activityLogs.map((log, i) => (
                  <tr key={log.id ?? i} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-3">
                      <span className="font-mono text-xs bg-white/[0.06] text-slate-400 px-1.5 py-0.5 rounded">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-400">
                      {log.resource} {log.resourceId ? `(${log.resourceId.slice(0, 8)})` : ""}
                    </td>
                    <td className="px-6 py-3 text-slate-500">{log.actor?.slice(0, 8) ?? "system"}</td>
                    <td className="px-6 py-3 text-slate-600">{new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
