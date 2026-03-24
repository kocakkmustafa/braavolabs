"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const RISK_LABELS: Record<string, { label: string; color: string }> = {
  "governance.hard_stop": { label: "Hard Stop", color: "bg-red-100 text-red-800" },
  "governance.loop_stop": { label: "Loop Detected", color: "bg-orange-100 text-orange-800" },
  "governance.cost_anomaly_stop": { label: "Cost Anomaly", color: "bg-yellow-100 text-yellow-800" },
  "governance.spam_stop": { label: "Spam Protection", color: "bg-purple-100 text-purple-800" },
  "governance.brand_violation_stop": { label: "Brand Violation", color: "bg-pink-100 text-pink-800" },
  "run.failed": { label: "Run Failed", color: "bg-red-100 text-red-800" },
  "run.stop": { label: "Run Stopped", color: "bg-gray-100 text-gray-800" },
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

  if (!token) return <p className="text-gray-500">Please login first.</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Risk Monitor</h1>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 uppercase">Total Risk Events</p>
          <p className="text-2xl font-bold text-red-600 mt-1">{events.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 uppercase">Loop Stops</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">
            {events.filter((e) => e.action === "governance.loop_stop").length}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 uppercase">Cost Anomalies</p>
          <p className="text-2xl font-bold text-yellow-600 mt-1">
            {events.filter((e) => e.action === "governance.cost_anomaly_stop").length}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500 uppercase">Failed Runs</p>
          <p className="text-2xl font-bold text-gray-600 mt-1">
            {events.filter((e) => e.action === "run.failed").length}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        <button
          onClick={() => setTab("risks")}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium ${
            tab === "risks" ? "bg-white border-b-2 border-blue-600 text-blue-600" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Risk Events ({events.length})
        </button>
        <button
          onClick={() => setTab("activity")}
          className={`px-4 py-2 rounded-t-lg text-sm font-medium ${
            tab === "activity" ? "bg-white border-b-2 border-blue-600 text-blue-600" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          Activity Log ({activityLogs.length})
        </button>
      </div>

      {tab === "risks" ? (
        events.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
            <p>No risk events detected. All systems running normally.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow">
            {events.map((e, i) => {
              const info = RISK_LABELS[e.action] ?? { label: e.action, color: "bg-gray-100 text-gray-800" };
              return (
                <div key={e.id ?? i} className={`px-6 py-4 ${i > 0 ? "border-t" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${info.color}`}>
                        {info.label}
                      </span>
                      <span className="text-sm">{e.resource}: {e.resourceId?.slice(0, 8) ?? "—"}</span>
                    </div>
                    <span className="text-xs text-gray-400">
                      {new Date(e.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {e.details && (
                    <p className="text-xs text-gray-500 mt-1">
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
          <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
            <p>No activity recorded yet.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Action</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Resource</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Actor</th>
                  <th className="text-left px-6 py-3 text-gray-500 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {activityLogs.map((log, i) => (
                  <tr key={log.id ?? i} className="border-t hover:bg-gray-50">
                    <td className="px-6 py-3">
                      <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      {log.resource} {log.resourceId ? `(${log.resourceId.slice(0, 8)})` : ""}
                    </td>
                    <td className="px-6 py-3 text-gray-500">{log.actor?.slice(0, 8) ?? "system"}</td>
                    <td className="px-6 py-3 text-gray-400">{new Date(log.createdAt).toLocaleString()}</td>
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
