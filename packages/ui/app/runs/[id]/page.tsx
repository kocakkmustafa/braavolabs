"use client";

/**
 * /runs/[id] — single run detail with audit trail.
 *
 * Shows the full step-by-step record (RunStep + ToolCall) for a run.
 * Linked from /dashboard's Recent runs panel rows. Useful for the
 * "what did the agent actually do" question — the heart of the
 * audited-by-default value prop.
 */

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import { timeAgo } from "../../../lib/timeAgo";
import { RunStepHeatmap } from "../../../components/RunStepHeatmap";

interface RunDetail {
  id: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  costUsd?: number;
  error?: string | null;
  pipeline?: { id?: string; name?: string; company?: { name?: string } };
  steps?: Array<{
    id: string;
    stepIndex: number;
    agentRole?: string;
    name?: string;
    status: string;
    reasoning?: string;
    costUsd?: number | string | null;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    toolCalls?: Array<{ id: string; toolName: string; status: string; durationMs?: number; error?: string | null }>;
  }>;
  approvals?: Array<{ id: string; status: string; type?: string; description?: string }>;
}

export default function RunDetailPage() {
  const { token, hydrated } = useAuthGuard();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stepRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const scrollToStep = (stepId: string) => {
    const node = stepRefs.current.get(stepId);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    // Add a brief highlight pulse to draw the eye.
    node.style.outline = "2px solid rgba(0,209,255,0.55)";
    node.style.outlineOffset = "2px";
    window.setTimeout(() => {
      node.style.outline = "";
      node.style.outlineOffset = "";
    }, 1400);
  };

  useEffect(() => {
    if (!token || !runId) return;
    setLoaded(false);
    api.getRun(token, runId)
      .then(setRun)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load run"))
      .finally(() => setLoaded(true));
  }, [token, runId]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
      </div>
    );
  }

  return (
    <div className="bv-dash bv-dash-shell">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div style={{ marginBottom: 16 }}>
          <Link href="/runs" style={{ color: "var(--color-primary, #a4e6ff)", fontSize: 13, textDecoration: "none" }}>
            ← Runs
          </Link>
        </div>

        {!loaded ? (
          <div className="animate-shimmer" style={{ height: 96, borderRadius: 16 }} />
        ) : err ? (
          <div className="bv-glass bv-panel">
            <p style={{ color: "var(--color-error, #f87171)" }}>{err}</p>
          </div>
        ) : !run ? (
          <div className="bv-glass bv-panel">
            <p>Run not found.</p>
          </div>
        ) : (
          <>
            <div className="bv-page-head bv-rise" style={{ marginBottom: 24 }}>
              <div>
                <div className="bv-micro" style={{ marginBottom: 6 }}>Run audit trail</div>
                <h1 className="bv-display" style={{ margin: 0, fontSize: 26 }}>
                  <span className="bv-grad-text">{run.pipeline?.name ?? "Pipeline"}</span>
                </h1>
                <div className="bv-caption" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="bv-mono">{run.id}</span>
                  <span className="bv-divider-dot" aria-hidden />
                  <StatusLabel status={(run.status ?? "running").toLowerCase()} />
                  {run.pipeline?.company?.name && (
                    <>
                      <span className="bv-divider-dot" aria-hidden />
                      <span>{run.pipeline.company.name}</span>
                    </>
                  )}
                  {run.startedAt && (
                    <>
                      <span className="bv-divider-dot" aria-hidden />
                      <span>Started {timeAgo(run.startedAt)}</span>
                    </>
                  )}
                  {typeof run.costUsd === "number" && (
                    <>
                      <span className="bv-divider-dot" aria-hidden />
                      <span className="bv-mono">${run.costUsd.toFixed(2)}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {run.error && (
              <div className="bv-glass bv-panel" style={{ marginBottom: 16, borderColor: "rgba(248,113,113,0.25)" }}>
                <h2 className="bv-title" style={{ color: "#f87171" }}>Run error</h2>
                <pre className="bv-mono" style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--color-on-surface-variant)" }}>
                  {run.error}
                </pre>
              </div>
            )}

            {/* Live cost-per-task heatmap — extends the per-step spend
                summary into an at-a-glance visualisation. Skipped while
                the run has fewer than 2 steps because a single bar adds
                no information. */}
            {run.steps && run.steps.length >= 2 && (
              <div style={{ marginBottom: 16 }}>
                <RunStepHeatmap
                  steps={run.steps}
                  totalCostUsd={run.costUsd}
                  onSelectStep={scrollToStep}
                />
              </div>
            )}

            <section className="bv-glass bv-panel">
              <header className="bv-panel-head">
                <div>
                  <h2 className="bv-title">Steps</h2>
                  <div className="bv-caption">
                    {run.steps?.length ?? 0} step{(run.steps?.length ?? 0) === 1 ? "" : "s"}
                  </div>
                </div>
              </header>

              {(!run.steps || run.steps.length === 0) ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
                  No steps recorded yet.
                </div>
              ) : (
                <ol className="bv-stagger" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {run.steps.map((s, idx) => (
                    <li
                      key={s.id}
                      ref={(el) => {
                        if (el) stepRefs.current.set(s.id, el);
                        else stepRefs.current.delete(s.id);
                      }}
                      style={{
                        padding: 14,
                        border: "1px solid var(--bv-glass-border)",
                        borderRadius: 12,
                        background: "rgba(255,255,255,0.02)",
                        transition: "outline 0.3s ease-out, outline-offset 0.3s ease-out",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span className="bv-pill bv-pill-muted">step {idx + 1}</span>
                            <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                              {s.agentRole ?? "Agent"}
                            </span>
                            <StatusLabel status={(s.status ?? "running").toLowerCase()} />
                          </div>
                          {s.reasoning && (
                            <p style={{ margin: 0, fontSize: 12, color: "var(--color-on-surface-variant)", lineHeight: 1.5 }}>
                              {s.reasoning}
                            </p>
                          )}
                        </div>
                        <div className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11, whiteSpace: "nowrap" }}>
                          {s.durationMs != null ? `${(s.durationMs / 1000).toFixed(2)}s` : ""}
                        </div>
                      </div>

                      {(s.toolCalls && s.toolCalls.length > 0) && (
                        <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                          {s.toolCalls.map((tc) => (
                            <li key={tc.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "rgba(0,0,0,0.18)", fontSize: 12 }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 14, color: "var(--color-outline)" }}>build</span>
                              <span className="bv-mono">{tc.toolName}</span>
                              <StatusLabel status={(tc.status ?? "completed").toLowerCase()} />
                              {tc.durationMs != null && (
                                <span className="bv-mono" style={{ color: "var(--color-outline)", marginLeft: "auto" }}>
                                  {(tc.durationMs / 1000).toFixed(2)}s
                                </span>
                              )}
                              {tc.error && (
                                <span style={{ color: "#f87171", fontSize: 11, marginLeft: 6 }}>{tc.error}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {run.approvals && run.approvals.length > 0 && (
              <section className="bv-glass bv-panel" style={{ marginTop: 16 }}>
                <header className="bv-panel-head">
                  <div>
                    <h2 className="bv-title">Approvals on this run</h2>
                    <div className="bv-caption">{run.approvals.length} record{run.approvals.length === 1 ? "" : "s"}</div>
                  </div>
                </header>
                <ul className="bv-approval-list">
                  {run.approvals.map((a) => (
                    <li key={a.id} className="bv-approval-item">
                      <span className="bv-approval-icon" aria-hidden>
                        <span className="material-symbols-outlined">approval</span>
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="bv-approval-title">{a.description ?? a.type ?? "Approval"}</div>
                        <div className="bv-approval-meta">{a.status}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: string }) {
  const label =
    status === "running" ? "Running" :
    status === "completed" ? "Completed" :
    status === "paused" ? "Paused" :
    status === "failed" ? "Failed" :
    status === "cancelled" ? "Cancelled" :
    status === "waiting_approval" ? "Awaiting approval" :
    "Pending";
  const cls = status === "waiting_approval" || status === "pending" ? "bv-pending" : status;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`bv-dot bv-${cls} ${status === "running" ? "bv-ping" : ""}`} aria-hidden />
      <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
}
