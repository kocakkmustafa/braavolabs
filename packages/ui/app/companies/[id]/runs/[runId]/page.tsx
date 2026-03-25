"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, apiFetch } from "../../../../../lib/api";
import { useAppStore } from "../../../../../lib/store";

interface RunStep {
  id: string;
  name: string;
  stepIndex: number;
  status: string;
  reasoning: string;
  input: any;
  output: any;
  costUsd: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  toolCalls: Array<{
    id: string;
    toolName: string;
    input: any;
    output: any;
    status: string;
    durationMs: number;
    error: string | null;
  }>;
}

interface RunDetail {
  id: string;
  status: string;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
  steps: RunStep[];
  pipeline: { name: string; company: { name: string } };
}

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  RUNNING:          { bg: "rgba(0,209,255,0.1)",   color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.2)" },
  COMPLETED:        { bg: "rgba(52,211,153,0.1)",  color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" },
  FAILED:           { bg: "rgba(239,68,68,0.1)",   color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" },
  CANCELLED:        { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" },
  PAUSED:           { bg: "rgba(251,191,36,0.1)",  color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" },
  WAITING_APPROVAL: { bg: "rgba(251,146,60,0.1)",  color: "#fb923c", border: "1px solid rgba(251,146,60,0.2)" },
  ROLLED_BACK:      { bg: "rgba(109,17,173,0.1)",  color: "#e0b6ff", border: "1px solid rgba(109,17,173,0.2)" },
};
const DEFAULT_STATUS = { bg: "rgba(133,147,153,0.1)", color: "#859399", border: "1px solid rgba(133,147,153,0.2)" };

const STEP_DOT_COLORS: Record<string, string> = {
  COMPLETED:  "#34d399",
  RUNNING:    "#a4e6ff",
  FAILED:     "#f87171",
  ROLLED_BACK:"#e0b6ff",
  PAUSED:     "#fbbf24",
};

export default function RunDetailPage() {
  const params = useParams();
  const token = useAppStore((s) => s.token);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !params.runId) return;
    api.getRun(token, params.runId as string).then(setRun).catch((e) => setError(e.message));
  }, [token, params.runId]);

  async function handleAction(action: string) {
    if (!token || !run) return;
    setActionLoading(action);
    try {
      await apiFetch(`/runs/${run.id}/${action}`, { method: "POST", token });
      const updated = await api.getRun(token, run.id);
      setRun(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStepAction(stepId: string, action: "rollback" | "rerun") {
    if (!token) return;
    setActionLoading(`${action}_${stepId}`);
    try {
      await apiFetch(`/runs/steps/${stepId}/${action}`, { method: "POST", token });
      const updated = await api.getRun(token, run!.id);
      setRun(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Step action failed");
    } finally {
      setActionLoading(null);
    }
  }

  if (!token) return <p style={{ color: "#859399", padding: 32 }}>Please log in first.</p>;
  if (error) return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }}>
      <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171", padding: 16, borderRadius: 12 }}>{error}</div>
    </div>
  );
  if (!run) return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }}>
      <div className="animate-shimmer" style={{ height: 32, width: 192, borderRadius: 8, background: "rgba(255,255,255,0.06)", marginBottom: 16 }} />
      <div className="animate-shimmer" style={{ height: 128, borderRadius: 16, background: "rgba(255,255,255,0.04)" }} />
    </div>
  );

  const runSt = STATUS_STYLES[run.status] ?? DEFAULT_STATUS;

  return (
    <div style={{ maxWidth: 896, margin: "0 auto", padding: "32px 24px" }} className="animate-fade-in">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>Run Detail</h1>
          <p style={{ color: "#859399", fontSize: 14, marginTop: 4, marginBottom: 0 }}>
            {run.pipeline.company.name} / {run.pipeline.name}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {run.status === "RUNNING" && (
            <>
              <button
                onClick={() => handleAction("pause")}
                disabled={!!actionLoading}
                style={{
                  padding: "8px 18px",
                  background: "rgba(251,191,36,0.1)",
                  color: "#fbbf24",
                  border: "1px solid rgba(251,191,36,0.2)",
                  borderRadius: 12,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: actionLoading ? "not-allowed" : "pointer",
                  opacity: actionLoading ? 0.5 : 1,
                }}
              >
                Pause
              </button>
              <button
                onClick={() => handleAction("stop")}
                disabled={!!actionLoading}
                style={{
                  padding: "8px 18px",
                  background: "rgba(239,68,68,0.1)",
                  color: "#f87171",
                  border: "1px solid rgba(239,68,68,0.2)",
                  borderRadius: 12,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: actionLoading ? "not-allowed" : "pointer",
                  opacity: actionLoading ? 0.5 : 1,
                }}
              >
                Hard Stop
              </button>
            </>
          )}
          {run.status === "PAUSED" && (
            <button
              onClick={() => handleAction("resume")}
              disabled={!!actionLoading}
              style={{
                padding: "8px 18px",
                background: "#34d399",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                fontSize: 13,
                fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer",
                opacity: actionLoading ? 0.5 : 1,
              }}
            >
              Resume
            </button>
          )}
        </div>
      </div>

      {/* Run Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        <div style={{ background: "rgba(29,32,38,0.8)", backdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 10, color: "#859399", letterSpacing: "0.08em", marginBottom: 8, marginTop: 0 }}>STATUS</p>
          <span
            style={{
              display: "inline-block",
              padding: "4px 10px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              background: runSt.bg,
              color: runSt.color,
              border: runSt.border,
            }}
          >
            {run.status}
          </span>
        </div>
        <div style={{ background: "rgba(29,32,38,0.8)", backdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 10, color: "#859399", letterSpacing: "0.08em", marginBottom: 4, marginTop: 0 }}>STEPS</p>
          <p style={{ fontSize: 22, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>{run.steps.length}</p>
        </div>
        <div style={{ background: "rgba(29,32,38,0.8)", backdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 10, color: "#859399", letterSpacing: "0.08em", marginBottom: 4, marginTop: 0 }}>COST</p>
          <p style={{ fontSize: 22, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>${(run.costUsd ?? 0).toFixed(4)}</p>
        </div>
        <div style={{ background: "rgba(29,32,38,0.8)", backdropFilter: "blur(24px)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 10, color: "#859399", letterSpacing: "0.08em", marginBottom: 4, marginTop: 0 }}>DURATION</p>
          <p style={{ fontSize: 22, fontWeight: 700, color: "#e1e2eb", margin: 0 }}>
            {run.completedAt
              ? `${((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000).toFixed(1)}s`
              : "..."}
          </p>
        </div>
      </div>

      {/* Step Timeline */}
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "#e1e2eb", marginBottom: 16 }}>Step Timeline</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {run.steps.map((step, idx) => {
          const st = STATUS_STYLES[step.status] ?? DEFAULT_STATUS;
          const dotColor = STEP_DOT_COLORS[step.status] ?? "#3c494e";
          return (
            <div
              key={step.id}
              style={{
                background: "rgba(29,32,38,0.8)",
                backdropFilter: "blur(24px)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 16,
                overflow: "hidden",
              }}
            >
              {/* Step Header */}
              <button
                onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: 16,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  transition: "background 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      background: dotColor,
                      boxShadow: step.status === "RUNNING" ? `0 0 8px ${dotColor}` : "none",
                    }}
                  />
                  {idx < run.steps.length - 1 && (
                    <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.06)", marginTop: 4 }} />
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 500, color: "#e1e2eb", fontSize: 14 }}>{step.name}</span>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 8,
                        fontSize: 11,
                        fontWeight: 600,
                        background: st.bg,
                        color: st.color,
                        border: st.border,
                      }}
                    >
                      {step.status}
                    </span>
                  </div>
                  {step.reasoning && (
                    <p
                      style={{
                        fontSize: 12,
                        color: "#859399",
                        marginTop: 4,
                        marginBottom: 0,
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 1,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {step.reasoning}
                    </p>
                  )}
                </div>

                <div style={{ textAlign: "right", fontSize: 12, color: "#859399" }}>
                  <div>${(step.costUsd ?? 0).toFixed(4)}</div>
                  <div>{step.toolCalls.length} tool calls</div>
                </div>
              </button>

              {/* Expanded Detail */}
              {expandedStep === step.id && (
                <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 16px" }}>
                  {/* Reasoning */}
                  {step.reasoning && (
                    <div style={{ marginBottom: 16 }}>
                      <h4 style={{ fontSize: 10, fontWeight: 600, color: "#859399", letterSpacing: "0.08em", marginBottom: 8, marginTop: 0 }}>REASONING</h4>
                      <p
                        style={{
                          fontSize: 13,
                          color: "#bbc9cf",
                          background: "rgba(0,209,255,0.04)",
                          border: "1px solid rgba(0,209,255,0.08)",
                          padding: 12,
                          borderRadius: 12,
                          whiteSpace: "pre-wrap",
                          margin: 0,
                        }}
                      >
                        {step.reasoning}
                      </p>
                    </div>
                  )}

                  {/* Error */}
                  {step.error && (
                    <div style={{ marginBottom: 16 }}>
                      <h4 style={{ fontSize: 10, fontWeight: 600, color: "#f87171", letterSpacing: "0.08em", marginBottom: 8, marginTop: 0 }}>ERROR</h4>
                      <p
                        style={{
                          fontSize: 13,
                          color: "#f87171",
                          background: "rgba(239,68,68,0.1)",
                          border: "1px solid rgba(239,68,68,0.2)",
                          padding: 12,
                          borderRadius: 12,
                          margin: 0,
                        }}
                      >
                        {step.error}
                      </p>
                    </div>
                  )}

                  {/* Tool Calls */}
                  {step.toolCalls.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <h4 style={{ fontSize: 10, fontWeight: 600, color: "#859399", letterSpacing: "0.08em", marginBottom: 8, marginTop: 0 }}>TOOL CALLS</h4>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {step.toolCalls.map((tc) => (
                          <div
                            key={tc.id}
                            style={{
                              background: "rgba(255,255,255,0.03)",
                              border: "1px solid rgba(255,255,255,0.06)",
                              borderRadius: 12,
                              padding: 12,
                              fontSize: 12,
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                              <span style={{ fontFamily: "monospace", fontWeight: 500, color: "#bbc9cf" }}>{tc.toolName}</span>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ color: tc.status === "COMPLETED" ? "#34d399" : "#f87171" }}>
                                  {tc.status}
                                </span>
                                <span style={{ color: "#3c494e" }}>{tc.durationMs}ms</span>
                              </div>
                            </div>
                            {tc.input && (
                              <details style={{ marginTop: 4 }}>
                                <summary style={{ cursor: "pointer", color: "#859399" }}>Input</summary>
                                <pre
                                  style={{
                                    marginTop: 4,
                                    background: "rgba(0,0,0,0.2)",
                                    color: "#bbc9cf",
                                    padding: 8,
                                    borderRadius: 8,
                                    fontSize: 11,
                                    overflow: "auto",
                                    maxHeight: 128,
                                  }}
                                >
                                  {JSON.stringify(tc.input, null, 2)}
                                </pre>
                              </details>
                            )}
                            {tc.output && (
                              <details style={{ marginTop: 4 }}>
                                <summary style={{ cursor: "pointer", color: "#859399" }}>Output</summary>
                                <pre
                                  style={{
                                    marginTop: 4,
                                    background: "rgba(0,0,0,0.2)",
                                    color: "#bbc9cf",
                                    padding: 8,
                                    borderRadius: 8,
                                    fontSize: 11,
                                    overflow: "auto",
                                    maxHeight: 128,
                                  }}
                                >
                                  {JSON.stringify(tc.output, null, 2)}
                                </pre>
                              </details>
                            )}
                            {tc.error && (
                              <p style={{ color: "#f87171", marginTop: 4, marginBottom: 0 }}>{tc.error}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Step Actions */}
                  <div style={{ display: "flex", gap: 8 }}>
                    {(step.status === "COMPLETED" || step.status === "FAILED") && (
                      <button
                        onClick={() => handleStepAction(step.id, "rollback")}
                        disabled={!!actionLoading}
                        style={{
                          padding: "6px 14px",
                          border: "1px solid rgba(255,255,255,0.08)",
                          color: "#859399",
                          background: "transparent",
                          borderRadius: 12,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: actionLoading ? "not-allowed" : "pointer",
                          opacity: actionLoading ? 0.5 : 1,
                        }}
                      >
                        Rollback
                      </button>
                    )}
                    {(step.status === "FAILED" || step.status === "ROLLED_BACK") && (
                      <button
                        onClick={() => handleStepAction(step.id, "rerun")}
                        disabled={!!actionLoading}
                        style={{
                          padding: "6px 14px",
                          background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
                          color: "#fff",
                          border: "none",
                          borderRadius: 12,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: actionLoading ? "not-allowed" : "pointer",
                          opacity: actionLoading ? 0.5 : 1,
                        }}
                      >
                        Rerun Step
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
