"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";

export default function ApprovalsPage() {
  const { token, hydrated } = useAuthGuard();
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    api.listApprovals(token).then(setApprovals).catch(() => {});
  }, [token, hydrated]);

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    setLoading(true);
    setError(null);
    try {
      await api.decideApproval(token!, id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      decision === "APPROVED" ? sounds.success() : sounds.click();
    } catch (err) {
      console.error("Approval decision failed:", err);
      setError((err as Error).message);
      sounds.error();
    }
    setLoading(false);
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold font-headline gradient-text">Pending Approvals</h1>
        <p className="text-sm mt-1" style={{ color: "#859399" }}>Review and approve spend actions from your AI agents</p>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
          {error}
        </div>
      )}

      {approvals.length === 0 ? (
        <div className="glass-card rounded-2xl py-16 px-6 text-center">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 24, color: "#34d399" }}>check_circle</span>
          </div>
          <p className="font-semibold" style={{ color: "#bbc9cf" }}>All clear!</p>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>No pending approvals. Approvals are required only for spend actions.</p>
        </div>
      ) : (
        <div className="space-y-4 stagger-children">
          {approvals.map((a) => (
            <div key={a.id} className="glass-card rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <h3 className="font-semibold text-[15px]" style={{ color: "#e1e2eb" }}>
                    {a.run?.pipeline?.company?.name ?? "Unknown Company"}
                  </h3>
                  <p className="text-sm mt-1.5" style={{ color: "#859399" }}>{a.description}</p>
                  {a.amountUsd && (
                    <p className="text-[26px] font-bold mt-2 gradient-text">
                      ${Number(a.amountUsd).toFixed(2)}
                    </p>
                  )}
                  <p className="text-[11px] mt-2" style={{ color: "#3c494e" }}>
                    Run: {a.runId?.slice(0, 8)} &bull; {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => decide(a.id, "APPROVED")}
                    disabled={loading}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                    style={{ background: "#34d399" }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(a.id, "REJECTED")}
                    disabled={loading}
                    className="px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50"
                    style={{ color: "#f87171", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
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
