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

  if (!token) return <p className="text-slate-500 p-8">Please login first.</p>;

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
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">Pending Approvals</h1>
        <p className="text-sm text-slate-500 mt-0.5">Review and approve spend actions from your AI agents</p>
      </div>

      {approvals.length === 0 ? (
        <div className="card-glass text-center py-16">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
          </div>
          <p className="font-semibold text-slate-300">All clear!</p>
          <p className="text-sm text-slate-500 mt-1">No pending approvals. Approvals are required only for spend actions.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <div key={a.id} className="card-glass p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-slate-200">
                    {a.run?.pipeline?.company?.name ?? "Unknown Company"}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">{a.description}</p>
                  {a.amountUsd && (
                    <p className="text-2xl font-bold text-brand-400 mt-2">
                      ${Number(a.amountUsd).toFixed(2)}
                    </p>
                  )}
                  <p className="text-xs text-slate-600 mt-2">
                    Run: {a.runId?.slice(0, 8)} &bull; {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => decide(a.id, "APPROVED")}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(a.id, "REJECTED")}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
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
