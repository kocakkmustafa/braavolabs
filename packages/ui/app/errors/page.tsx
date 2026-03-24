"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

interface FailedRun {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  pipeline: {
    name: string;
    company: { id: string; name: string };
  };
  _count: { steps: number };
}

export default function ErrorsPage() {
  const token = useAppStore((s) => s.token);
  const [runs, setRuns] = useState<FailedRun[]>([]);
  const [riskEvents, setRiskEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.listRuns(token, 100, 0).then((data) => {
        const failed = (data.runs ?? []).filter(
          (r: any) => r.status === "FAILED" || r.status === "CANCELLED",
        );
        setRuns(failed);
      }).catch(() => {}),
      api.riskEvents(token, 50).then(setRiskEvents).catch(() => setRiskEvents([])),
    ]).finally(() => setLoading(false));
  }, [token]);

  if (!token) return <p className="text-gray-500">Please log in first.</p>;
  if (loading) return <p className="text-gray-500">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Errors & Risk Events</h1>

      {/* Failed Runs */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Failed & Cancelled Runs ({runs.length})</h2>
        {runs.length > 0 ? (
          <div className="space-y-3">
            {runs.map((run) => (
              <a
                key={run.id}
                href={`/companies/${run.pipeline?.company?.id}/runs/${run.id}`}
                className="block bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{run.pipeline?.name ?? "Unknown"}</span>
                    <span className="text-gray-400 ml-2 text-sm">
                      {run.pipeline?.company?.name ?? ""}
                    </span>
                    <span
                      className={`ml-3 px-2 py-0.5 rounded-full text-xs font-medium ${
                        run.status === "FAILED"
                          ? "bg-red-100 text-red-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {run.status}
                    </span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-500">
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400">{run._count?.steps ?? 0} steps</p>
                  </div>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-center py-8 bg-white rounded-lg shadow">
            No failed runs. Everything is running smoothly!
          </p>
        )}
      </div>

      {/* Risk Events */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Risk Events ({riskEvents.length})</h2>
        {riskEvents.length > 0 ? (
          <div className="space-y-3">
            {riskEvents.map((event: any) => {
              const riskColors: Record<string, string> = {
                "governance.hard_stop": "bg-red-100 text-red-700",
                "governance.loop_stop": "bg-orange-100 text-orange-700",
                "governance.cost_anomaly_stop": "bg-yellow-100 text-yellow-700",
                "governance.spam_stop": "bg-purple-100 text-purple-700",
                "governance.brand_violation_stop": "bg-pink-100 text-pink-700",
              };
              return (
                <div key={event.id} className="bg-white rounded-lg shadow p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          riskColors[event.action] ?? "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {event.action}
                      </span>
                      {event.resourceId && (
                        <span className="text-gray-400 ml-2 text-xs">
                          {event.resourceId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-gray-500">
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {event.details && (
                    <pre className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-2 overflow-auto">
                      {JSON.stringify(event.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-gray-500 text-center py-8 bg-white rounded-lg shadow">
            No risk events detected.
          </p>
        )}
      </div>
    </div>
  );
}
