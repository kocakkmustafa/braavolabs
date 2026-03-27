"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

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
    } catch (err) {
      console.error("Approval decision failed:", err);
      setError((err as Error).message);
    }
    setLoading(false);
  }

  return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }} className="animate-fade-in">
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>Pending Approvals</h1>
        <p style={{ fontSize: 14, color: "#859399", marginTop: 4 }}>Review and approve spend actions from your AI agents</p>
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 12, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171", fontSize: 14 }}>
          {error}
        </div>
      )}

      {approvals.length === 0 ? (
        <div
          style={{
            background: "rgba(29,32,38,0.8)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 16,
            padding: "64px 24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 16,
              background: "rgba(52,211,153,0.1)",
              border: "1px solid rgba(52,211,153,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}
          >
            <svg width={24} height={24} fill="none" viewBox="0 0 24 24" stroke="#34d399" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <p style={{ fontWeight: 600, color: "#bbc9cf", margin: 0 }}>All clear!</p>
          <p style={{ fontSize: 13, color: "#859399", marginTop: 4 }}>No pending approvals. Approvals are required only for spend actions.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {approvals.map((a) => (
            <div
              key={a.id}
              style={{
                background: "rgba(29,32,38,0.8)",
                backdropFilter: "blur(24px)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 16,
                padding: "24px",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <h3 style={{ fontWeight: 600, color: "#e1e2eb", margin: 0, fontSize: 15 }}>
                    {a.run?.pipeline?.company?.name ?? "Unknown Company"}
                  </h3>
                  <p style={{ fontSize: 13, color: "#859399", marginTop: 6, marginBottom: 0 }}>{a.description}</p>
                  {a.amountUsd && (
                    <p
                      style={{
                        fontSize: 26,
                        fontWeight: 700,
                        marginTop: 8,
                        marginBottom: 0,
                        background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
                        WebkitBackgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                      }}
                    >
                      ${Number(a.amountUsd).toFixed(2)}
                    </p>
                  )}
                  <p style={{ fontSize: 11, color: "#3c494e", marginTop: 8, marginBottom: 0 }}>
                    Run: {a.runId?.slice(0, 8)} &bull; {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    onClick={() => decide(a.id, "APPROVED")}
                    disabled={loading}
                    style={{
                      padding: "8px 18px",
                      borderRadius: 10,
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#fff",
                      background: "#34d399",
                      border: "none",
                      cursor: loading ? "not-allowed" : "pointer",
                      opacity: loading ? 0.5 : 1,
                      transition: "opacity 0.2s",
                    }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(a.id, "REJECTED")}
                    disabled={loading}
                    style={{
                      padding: "8px 18px",
                      borderRadius: 10,
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#f87171",
                      background: "rgba(239,68,68,0.1)",
                      border: "1px solid rgba(239,68,68,0.2)",
                      cursor: loading ? "not-allowed" : "pointer",
                      opacity: loading ? 0.5 : 1,
                      transition: "opacity 0.2s",
                    }}
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
