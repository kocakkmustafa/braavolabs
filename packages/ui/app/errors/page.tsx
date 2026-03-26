"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

const RISK_BADGE_STYLES: Record<string, { background: string; color: string; border: string }> = {
  "governance.hard_stop": { background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)" },
  "governance.loop_stop": { background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.25)" },
  "governance.cost_anomaly_stop": { background: "rgba(251,191,36,0.08)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
  "governance.spam_stop": { background: "rgba(109,17,173,0.15)", color: "#e0b6ff", border: "1px solid rgba(109,17,173,0.3)" },
  "governance.brand_violation_stop": { background: "rgba(239,68,68,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" },
};

const DEFAULT_BADGE = { background: "rgba(133,147,153,0.12)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

export default function ErrorsPage() {
  const token = useAppStore((s) => s.token);
  const router = useRouter();
  const [runs, setRuns] = useState<FailedRun[]>([]);
  const [riskEvents, setRiskEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      router.push("/login");
      return;
    }
    Promise.all([
      api.listRuns(token, 100, 0).then((data) => {
        const failed = (data.runs ?? []).filter(
          (r: any) => r.status === "FAILED" || r.status === "CANCELLED",
        );
        setRuns(failed);
      }).catch(() => {}),
      api.riskEvents(token, 50).then(setRiskEvents).catch(() => setRiskEvents([])),
    ]).finally(() => setLoading(false));
  }, [token, router]);

  if (!token) return null;

  if (loading) {
    return (
      <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ height: 32, width: 200, borderRadius: 8, background: "rgba(255,255,255,0.06)", marginBottom: 24 }} className="animate-shimmer" />
        <div style={{ height: 80, borderRadius: 16, background: "rgba(255,255,255,0.04)", marginBottom: 12 }} className="animate-shimmer" />
        <div style={{ height: 80, borderRadius: 16, background: "rgba(255,255,255,0.04)" }} className="animate-shimmer" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }} className="animate-fade-in">
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>Errors &amp; Risk Events</h1>
        <p style={{ fontSize: 14, color: "#859399", marginTop: 4 }}>Failed runs and governance risk events from your AI agents</p>
      </div>

      {/* Failed Runs */}
      <div style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#bbc9cf", marginBottom: 16 }}>
          Failed &amp; Cancelled Runs ({runs.length})
        </h2>
        {runs.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {runs.map((run) => (
              <Link
                key={run.id}
                href={`/companies/${run.pipeline?.company?.id}/runs/${run.id}`}
                style={{
                  display: "block",
                  background: "rgba(29,32,38,0.8)",
                  backdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 16,
                  padding: "16px 20px",
                  textDecoration: "none",
                  transition: "border-color 0.2s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontWeight: 600, color: "#e1e2eb", fontSize: 14 }}>
                      {run.pipeline?.name ?? "Unknown"}
                    </span>
                    <span style={{ color: "#859399", fontSize: 13 }}>
                      {run.pipeline?.company?.name ?? ""}
                    </span>
                    <span
                      style={{
                        padding: "2px 10px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        ...(run.status === "FAILED"
                          ? { background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }
                          : { background: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" }),
                      }}
                    >
                      {run.status}
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 12, color: "#859399", margin: 0 }}>
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    <p style={{ fontSize: 11, color: "#3c494e", margin: "2px 0 0" }}>
                      {run._count?.steps ?? 0} steps
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div
            style={{
              background: "rgba(29,32,38,0.8)",
              backdropFilter: "blur(24px)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 16,
              padding: "48px 24px",
              textAlign: "center",
            }}
          >
            <div style={{ width: 48, height: 48, borderRadius: 16, background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <svg width={24} height={24} fill="none" viewBox="0 0 24 24" stroke="#34d399" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
            </div>
            <p style={{ fontWeight: 600, color: "#bbc9cf", margin: 0 }}>No failed runs</p>
            <p style={{ fontSize: 13, color: "#859399", marginTop: 4 }}>Everything is running smoothly!</p>
          </div>
        )}
      </div>

      {/* Risk Events */}
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#bbc9cf", marginBottom: 16 }}>
          Risk Events ({riskEvents.length})
        </h2>
        {riskEvents.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {riskEvents.map((event: any) => {
              const badge = RISK_BADGE_STYLES[event.action] ?? DEFAULT_BADGE;
              return (
                <div
                  key={event.id}
                  style={{
                    background: "rgba(29,32,38,0.8)",
                    backdropFilter: "blur(24px)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 16,
                    padding: "16px 20px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span
                        style={{
                          padding: "2px 10px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          ...badge,
                        }}
                      >
                        {event.action}
                      </span>
                      {event.resourceId && (
                        <span style={{ color: "#3c494e", fontSize: 11 }}>
                          {event.resourceId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: "#859399" }}>
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {event.details && (
                    <pre
                      style={{
                        marginTop: 10,
                        fontSize: 11,
                        color: "#bbc9cf",
                        background: "rgba(0,0,0,0.25)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        overflow: "auto",
                        maxHeight: 120,
                      }}
                    >
                      {JSON.stringify(event.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div
            style={{
              background: "rgba(29,32,38,0.8)",
              backdropFilter: "blur(24px)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 16,
              padding: "48px 24px",
              textAlign: "center",
            }}
          >
            <p style={{ fontWeight: 600, color: "#bbc9cf", margin: 0 }}>No risk events detected</p>
            <p style={{ fontSize: 13, color: "#859399", marginTop: 4 }}>Your agents are operating within all governance policies.</p>
          </div>
        )}
      </div>
    </div>
  );
}
