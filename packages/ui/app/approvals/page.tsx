"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

export default function ApprovalsPage() {
  const token = useAppStore((s) => s.token);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.listApprovals(token).then(setApprovals).catch(() => {});
  }, [token]);

  if (!token) return <p className="text-gray-500">Please login first.</p>;

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    setLoading(true);
    try {
      await api.decideApproval(token!, id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      alert((err as Error).message);
    }
    setLoading(false);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Pending Approvals</h1>

      {approvals.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
          <p>No pending approvals. Approvals are required only for spend actions.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <div key={a.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">
                    {a.run?.pipeline?.company?.name ?? "Unknown Company"}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">{a.description}</p>
                  {a.amountUsd && (
                    <p className="text-lg font-bold text-blue-600 mt-2">
                      ${Number(a.amountUsd).toFixed(2)}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-2">
                    Run: {a.runId?.slice(0, 8)} | Created: {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => decide(a.id, "APPROVED")}
                    disabled={loading}
                    className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(a.id, "REJECTED")}
                    disabled={loading}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
