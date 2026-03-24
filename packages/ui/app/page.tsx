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
  const [health, setHealth] = useState<HealthData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.health(token).then(setHealth).catch(() => {}),
      api.usage(token).then(setUsage).catch(() => {}),
      api.finance(token).then(setFinance).catch(() => {}),
    ]).catch((err) => setError(err.message));
  }, [token]);

  if (!token) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="bg-white rounded-lg shadow p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-bold mb-4">AI Company OS</h1>
          <p className="text-gray-500 mb-6">10 dakikada AI sirketini kur.</p>
          <TokenInput />
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <StatCard title="Active Companies" value={health?.activeCompanies ?? "—"} color="blue" />
        <StatCard title="Running Pipelines" value={health?.activeRuns ?? "—"} color="green" />
        <StatCard title="Pending Approvals" value={health?.pendingApprovals ?? "—"} color="yellow" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Usage This Month</h2>
          {usage ? (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-500">Total Runs</span>
                <span className="font-semibold">{usage.totalRuns}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Completed</span>
                <span className="font-semibold text-green-600">{usage.completedRuns}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Failed</span>
                <span className="font-semibold text-red-600">{usage.failedRuns}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Success Rate</span>
                <span className="font-semibold">{(usage.successRate * 100).toFixed(1)}%</span>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">Loading...</p>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Cost Summary</h2>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-500">Total Cost</span>
                <span className="font-semibold">${finance.totalCostUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Billable Runs</span>
                <span className="font-semibold">{finance.runCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Avg Cost/Run</span>
                <span className="font-semibold">${finance.avgCostPerRun.toFixed(4)}</span>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">Loading...</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, color }: { title: string; value: string | number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: "text-blue-600",
    green: "text-green-600",
    yellow: "text-yellow-600",
  };
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <p className="text-sm text-gray-500">{title}</p>
      <p className={`text-3xl font-bold mt-1 ${colorMap[color] ?? ""}`}>{value}</p>
    </div>
  );
}

function TokenInput() {
  const setAuth = useAppStore((s) => s.setAuth);
  const [input, setInput] = useState("");

  return (
    <div>
      <input
        type="text"
        placeholder="JWT Token"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="w-full border rounded-lg px-4 py-2 mb-4"
      />
      <button
        onClick={() => {
          if (input.trim()) {
            // Decode tenant from JWT payload (base64)
            try {
              const payload = JSON.parse(atob(input.split(".")[1]));
              setAuth(input, payload.tenantId ?? "default");
            } catch {
              setAuth(input, "default");
            }
          }
        }}
        className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
      >
        Login
      </button>
    </div>
  );
}
