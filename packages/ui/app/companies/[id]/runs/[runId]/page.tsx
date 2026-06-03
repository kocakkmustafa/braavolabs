"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { api, apiFetch } from "../../../../../lib/api";
import { streamRun } from "../../../../../lib/runStream";
import { useAppStore } from "../../../../../lib/store";
import { useTranslations } from "next-intl";

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
  /** Run-level error reason. Populated by the runner when any step fails
   * (since the 2026-04-28 fix); previously always null on FAILED runs. */
  error: string | null;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
  steps: RunStep[];
  pipeline: { name: string; company: { name: string } };
  approvals?: Array<{ id: string; type?: string; status: string; description?: string }>;
}

// FORGE status → bv-pill / dot colour mapping
const STATUS_DOT: Record<string, string> = {
  RUNNING:          "bv-running",
  COMPLETED:        "bv-completed",
  FAILED:           "bv-failed",
  CANCELLED:        "bv-cancelled",
  PAUSED:           "bv-paused",
  WAITING_APPROVAL: "bv-pending",
  ROLLED_BACK:      "bv-paused",
};
const STATUS_PILL: Record<string, string> = {
  RUNNING:          "bv-pill bv-pill-amber",
  COMPLETED:        "bv-pill bv-pill-cyan",
  FAILED:           "bv-pill bv-pill-red",
  CANCELLED:        "bv-pill bv-pill-muted",
  PAUSED:           "bv-pill bv-pill-muted",
  WAITING_APPROVAL: "bv-pill bv-pill-amber",
  ROLLED_BACK:      "bv-pill bv-pill-purple",
};
// Filament accent colours per step status
const STEP_FILAMENT: Record<string, string> = {
  COMPLETED:   "var(--bv-cobalt-glow)",
  RUNNING:     "var(--bv-status-running)",
  FAILED:      "var(--bv-status-failed)",
  ROLLED_BACK: "var(--color-secondary-fixed-dim)",
  PAUSED:      "var(--bv-steel-mid)",
};

const LIVE_STATUSES = ["RUNNING", "PAUSED", "WAITING_APPROVAL"];

export default function RunDetailPage() {
  const params = useParams();
  const t = useTranslations();
  const token = useAppStore((s) => s.token);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const [steerText, setSteerText] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [steerMsg, setSteerMsg] = useState<string | null>(null);
  const [steerOk, setSteerOk] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerMsg, setAnswerMsg] = useState<string | null>(null);
  const [answerOk, setAnswerOk] = useState(false);

  // Initial fetch
  useEffect(() => {
    if (!token || !params.runId) return;
    api.getRun(token, params.runId as string).then(setRun).catch((e) => setError(e.message));
  }, [token, params.runId]);

  // Live updates via SSE — replaces the old 2s polling. Each run event
  // triggers a debounced authoritative refetch; the stream ends itself on
  // the terminal `done` event. The autoRefresh toggle pauses live updates.
  useEffect(() => {
    if (!token || !run || !autoRefresh) return;
    if (!LIVE_STATUSES.includes(run.status)) return;

    const runId = run.id;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => { api.getRun(token, runId).then(setRun).catch(() => {}); };
    const stop = streamRun(token, runId, {
      onEvent: () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(refetch, 350);
      },
      onDone: refetch,
    });

    return () => {
      if (debounce) clearTimeout(debounce);
      stop();
    };
  }, [token, run?.id, run?.status, autoRefresh]);

  // Auto-scroll timeline on new steps
  useEffect(() => {
    if (run && LIVE_STATUSES.includes(run.status)) {
      timelineEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [run?.steps?.length]);

  async function handleAction(action: string) {
    if (!token || !run) return;
    setActionLoading(action);
    try {
      await apiFetch(`/runs/${run.id}/${action}`, { method: "POST", token });
      const updated = await api.getRun(token, run.id);
      setRun(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("app.runDetail.actionFailed"));
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
      setError(e instanceof Error ? e.message : t("app.runDetail.stepActionFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSteer() {
    if (!token || !run || !steerText.trim()) return;
    setSteerBusy(true);
    setSteerMsg(null);
    try {
      await api.steerRun(token, run.id, steerText.trim());
      setSteerText("");
      setSteerOk(true);
      setSteerMsg(t("app.runDetail.steerSent"));
    } catch (e) {
      setSteerOk(false);
      setSteerMsg(e instanceof Error ? e.message : t("app.runDetail.steerFailed"));
    } finally {
      setSteerBusy(false);
    }
  }

  async function handleAnswer(approvalId: string) {
    if (!token || !run || !answer.trim()) return;
    setAnswerBusy(true);
    setAnswerMsg(null);
    try {
      await api.decideApproval(token, approvalId, "APPROVED", answer.trim());
      setAnswer("");
      setAnswerOk(true);
      setAnswerMsg(t("app.runDetail.answerSent"));
      const updated = await api.getRun(token, run.id);
      setRun(updated);
    } catch (e) {
      setAnswerOk(false);
      setAnswerMsg(e instanceof Error ? e.message : t("app.runDetail.answerFailed"));
    } finally {
      setAnswerBusy(false);
    }
  }

  if (!token) return (
    <p className="bv-caption p-8">{t("app.runDetail.loginFirst")}</p>
  );

  if (error) return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <div
        className="rounded-xl p-4 flex items-start gap-3"
        style={{ background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.25)" }}
      >
        <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: 18, color: "var(--bv-status-failed)" }}>error</span>
        <span className="bv-body" style={{ color: "#fecaca" }}>{error}</span>
      </div>
    </div>
  );

  if (!run) return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-4">
      <div className="animate-shimmer rounded-xl" style={{ height: 32, width: 220 }} />
      <div className="animate-shimmer rounded-xl" style={{ height: 120 }} />
      <div className="animate-shimmer rounded-xl" style={{ height: 80 }} />
    </div>
  );

  const isLive = LIVE_STATUSES.includes(run.status);
  const pendingInput = (run.approvals ?? []).filter((a) => a.type === "INPUT" && a.status === "PENDING");
  const completedSteps = run.steps.filter((s) => s.status === "COMPLETED").length;
  const budgetUsd = 50; // display budget cap for the gauge
  const spendPct = Math.min((Number(run.costUsd ?? 0) / budgetUsd) * 100, 100);
  const statusDotCls = STATUS_DOT[run.status] ?? "bv-paused";
  const statusPillCls = STATUS_PILL[run.status] ?? "bv-pill bv-pill-muted";

  return (
    <div className="bv-dash animate-fade-in" style={{ paddingBottom: isLive ? 110 : 0 }}>
      {/* ── Page head ───────────────────────────────────────── */}
      <div className="bv-page-head mb-6">
        <div>
          {/* eyebrow */}
          <p className="bv-micro mb-1" style={{ color: "var(--bv-text-faint)" }}>
            {run.pipeline.company.name}
            <span className="bv-divider-dot" />
            {run.pipeline.name}
          </p>
          <h1 className="bv-headline">{t("app.runDetail.title")}</h1>
          <div className="flex items-center gap-2 mt-2">
            <span className={`bv-dot ${statusDotCls}${isLive ? " bv-ping" : ""}`} />
            <span className={statusPillCls}>{run.status}</span>
            <span className="bv-caption" style={{ color: "var(--bv-text-faint)" }}>· {run.id}</span>
          </div>
        </div>

        <div className="bv-page-head-actions">
          {/* Live / pause-refresh toggle */}
          {isLive && (
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className="bv-btn bv-btn-ghost bv-btn-sm flex items-center gap-1.5"
              title={autoRefresh ? t("app.runDetail.pauseRefresh") : t("app.runDetail.resumeRefresh")}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {autoRefresh ? "pause" : "play_arrow"}
              </span>
              {autoRefresh ? "Live" : "Paused"}
            </button>
          )}

          {run.status === "RUNNING" && (
            <>
              <button
                onClick={() => handleAction("pause")}
                disabled={!!actionLoading}
                className="bv-btn bv-btn-ghost bv-btn-sm disabled:opacity-50"
              >
                {t("app.runDetail.pause")}
              </button>
              <button
                onClick={() => handleAction("stop")}
                disabled={!!actionLoading}
                className="bv-btn bv-btn-danger bv-btn-sm disabled:opacity-50"
              >
                {t("app.runDetail.hardStop")}
              </button>
            </>
          )}
          {run.status === "PAUSED" && (
            <button
              onClick={() => handleAction("resume")}
              disabled={!!actionLoading}
              className="bv-btn bv-btn-primary bv-btn-sm disabled:opacity-50"
            >
              {t("app.runDetail.resume")}
            </button>
          )}
        </div>
      </div>

      {/* ── Risk banner — cost-stop armed ───────────────────── */}
      {isLive && spendPct >= 60 && (
        <div
          className="flex items-center gap-3 rounded-xl px-4 py-3 mb-5"
          style={{
            border: "1px solid rgba(255,77,77,0.4)",
            background: "linear-gradient(135deg,rgba(255,77,77,0.10),transparent)",
          }}
        >
          <span className="bv-dot bv-failed bv-ping" />
          <div>
            <p className="text-sm font-semibold text-on-surface">Cost-stop armed</p>
            <p className="bv-caption" style={{ color: "var(--color-on-surface-variant)" }}>
              budget {Math.round(spendPct)}% consumed — run will halt at ${budgetUsd.toFixed(2)}
            </p>
          </div>
        </div>
      )}

      {/* ── Run-level failure banner ─────────────────────────── */}
      {run.status === "FAILED" && run.error && (
        <div
          className="rounded-xl p-4 mb-5 flex items-start gap-3"
          style={{
            background: "rgba(255,77,77,0.08)",
            border: "1px solid rgba(255,77,77,0.25)",
          }}
          role="alert"
        >
          <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: 20, color: "var(--bv-status-failed)" }}>
            error
          </span>
          <div className="min-w-0 flex-1">
            <p className="bv-micro mb-1" style={{ color: "var(--bv-status-failed)" }}>
              {t("app.runDetail.runFailed")}
            </p>
            <p className="text-sm whitespace-pre-wrap break-words" style={{ color: "#fecaca" }}>
              {run.error}
            </p>
            {run.error.toLowerCase().includes("api") && run.error.toLowerCase().includes("key") && (
              <a href="/settings#ai_provider" className="inline-block mt-3 bv-micro underline" style={{ color: "#fca5a5" }}>
                {t("app.runDetail.remSettings")}
              </a>
            )}
            {run.error.toLowerCase().includes("quota") && (
              <a href="/billing" className="inline-block mt-3 bv-micro underline" style={{ color: "#fca5a5" }}>
                {t("app.runDetail.remBilling")}
              </a>
            )}
            {run.error.toLowerCase().includes("approval") && (
              <a href="/approvals" className="inline-block mt-3 bv-micro underline" style={{ color: "#fca5a5" }}>
                {t("app.runDetail.remApprovals")}
              </a>
            )}
          </div>
        </div>
      )}

      {/* ── Two-column layout: stream + right rail ───────────── */}
      <div className="bv-twocol">

        {/* ── LEFT: step-node stream ───────────────────────── */}
        <div className="bv-twocol-main">

          {/* ask_user — pending input card (arc glow) */}
          {pendingInput.length > 0 && (
            <div
              className="bv-glass rounded-2xl p-5"
              style={{
                border: "1px solid rgba(96,165,250,0.4)",
                background: "linear-gradient(135deg,rgba(59,130,246,0.09),transparent)",
                boxShadow: "0 0 36px -10px var(--bv-cobalt-glow)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#60A5FA" }}>contact_support</span>
                <h3 className="bv-title" style={{ color: "#60A5FA" }}>{t("app.runDetail.inputTitle")}</h3>
                <span className="bv-pill bv-pill-cyan ml-auto">awaiting you</span>
              </div>
              <p className="text-sm mb-4" style={{ color: "var(--color-on-surface)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                {pendingInput[0].description}
              </p>
              <div className="flex gap-3">
                <input
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) handleAnswer(pendingInput[0].id); }}
                  placeholder={t("app.runDetail.answerPlaceholder")}
                  className="flex-1 rounded-xl px-4 py-3 text-sm outline-none"
                  style={{
                    background: "rgba(5,8,16,0.6)",
                    border: "1px solid rgba(96,165,250,0.25)",
                    color: "var(--color-on-surface)",
                  }}
                  autoFocus
                />
                <button
                  onClick={() => handleAnswer(pendingInput[0].id)}
                  disabled={answerBusy || !answer.trim()}
                  className="bv-btn bv-btn-primary disabled:opacity-50 whitespace-nowrap"
                >
                  {answerBusy ? t("app.runDetail.sending") : t("app.runDetail.sendAnswer")}
                </button>
              </div>
              {answerMsg && (
                <p className="bv-caption mt-2" style={{ color: answerOk ? "var(--bv-cobalt-glow)" : "var(--bv-status-failed)" }}>{answerMsg}</p>
              )}
            </div>
          )}

          {/* Step nodes — arc filament chain */}
          <div className="flex flex-col" style={{ gap: 0 }}>
            {run.steps.map((step, idx) => {
              const filamentColor = STEP_FILAMENT[step.status] ?? "var(--bv-steel-shadow)";
              const isRunning = step.status === "RUNNING";
              const isExpanded = expandedStep === step.id;
              const pillCls = STATUS_PILL[step.status] ?? "bv-pill bv-pill-muted";
              const dotCls = STATUS_DOT[step.status] ?? "bv-paused";
              const isLast = idx === run.steps.length - 1;

              return (
                <div key={step.id} style={{ display: "grid", gridTemplateColumns: "34px 1fr", gap: 16 }}>
                  {/* Rail column: node dot + filament */}
                  <div className="flex flex-col items-center">
                    <div style={{ marginTop: 18, zIndex: 2, position: "relative" }}>
                      <span
                        className={`bv-dot ${dotCls}${isRunning ? " bv-ping" : ""}`}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: isRunning ? "var(--bv-status-running)" : filamentColor,
                          border: `2px solid ${filamentColor}`,
                          boxShadow: isRunning ? `0 0 14px var(--bv-status-running)` : `0 0 8px ${filamentColor}`,
                          display: "block",
                        }}
                      />
                    </div>
                    {!isLast && (
                      <div
                        style={{
                          flex: 1,
                          width: 2,
                          marginTop: 4,
                          background: `linear-gradient(180deg,${filamentColor},rgba(59,130,246,0.08))`,
                          minHeight: 24,
                        }}
                      />
                    )}
                  </div>

                  {/* Card column */}
                  <div style={{ paddingBottom: isLast ? 0 : 18 }}>
                    <div
                      className="bv-glass rounded-2xl overflow-hidden"
                      style={{
                        border: isRunning
                          ? "1px solid rgba(255,122,26,0.35)"
                          : "1px solid rgba(255,255,255,0.06)",
                        background: isRunning
                          ? "linear-gradient(135deg,rgba(255,122,26,0.06),transparent)"
                          : undefined,
                      }}
                    >
                      {/* Step header — clickable to expand */}
                      <button
                        onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                        className="w-full flex items-start gap-3 px-4 pt-4 pb-3 text-left"
                        style={{ background: "transparent", border: "none", cursor: "pointer" }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span
                              className="font-mono text-xs tracking-widest"
                              style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.06em" }}
                            >
                              {step.name}
                            </span>
                            {isRunning && (
                              <span className="bv-pill bv-pill-amber">streaming</span>
                            )}
                            <span className={pillCls}>{step.status}</span>
                            <span
                              className="font-mono text-xs ml-auto"
                              style={{ color: "var(--color-on-surface-variant)" }}
                            >
                              ${Number(step.costUsd ?? 0).toFixed(4)}
                            </span>
                          </div>
                          {step.reasoning && (
                            <p
                              className="text-sm"
                              style={{ color: "var(--color-on-surface)", lineHeight: 1.55 }}
                            >
                              {step.reasoning}
                              {isRunning && (
                                <span
                                  className="inline-block animate-blink"
                                  style={{
                                    width: 7,
                                    height: 14,
                                    background: "var(--bv-status-running)",
                                    verticalAlign: "-2px",
                                    marginLeft: 2,
                                    borderRadius: 1,
                                  }}
                                />
                              )}
                            </p>
                          )}
                          <p className="bv-micro mt-1" style={{ color: "var(--bv-text-faint)" }}>
                            {t("app.runDetail.toolCallCount", { n: step.toolCalls.length })}
                          </p>
                        </div>
                        <span
                          className="material-symbols-outlined flex-shrink-0 mt-0.5"
                          style={{
                            fontSize: 16,
                            color: "var(--bv-text-faint)",
                            transform: isExpanded ? "rotate(180deg)" : "none",
                            transition: "transform 0.2s",
                          }}
                        >
                          expand_more
                        </span>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div
                          style={{
                            borderTop: "1px solid rgba(255,255,255,0.06)",
                            padding: "14px 16px 16px",
                          }}
                        >
                          {/* Reasoning block */}
                          {step.reasoning && (
                            <div className="mb-4">
                              <h4 className="bv-micro mb-2">{t("app.runDetail.reasoning")}</h4>
                              <p
                                className="text-xs rounded-xl p-3 whitespace-pre-wrap"
                                style={{
                                  color: "var(--color-on-surface-variant)",
                                  background: "rgba(59,130,246,0.04)",
                                  border: "1px solid rgba(59,130,246,0.08)",
                                  lineHeight: 1.6,
                                }}
                              >
                                {step.reasoning}
                              </p>
                            </div>
                          )}

                          {/* Error block */}
                          {step.error && (
                            <div className="mb-4">
                              <h4 className="bv-micro mb-2" style={{ color: "var(--bv-status-failed)" }}>{t("app.runDetail.errorLabel")}</h4>
                              <p
                                className="text-xs rounded-xl p-3"
                                style={{
                                  color: "var(--bv-status-failed)",
                                  background: "rgba(255,77,77,0.08)",
                                  border: "1px solid rgba(255,77,77,0.20)",
                                }}
                              >
                                {step.error}
                              </p>
                            </div>
                          )}

                          {/* Tool calls */}
                          {step.toolCalls.length > 0 && (
                            <div className="mb-4">
                              <h4 className="bv-micro mb-2">{t("app.runDetail.toolCalls")}</h4>
                              <div className="flex flex-col gap-2">
                                {step.toolCalls.map((tc) => (
                                  <div
                                    key={tc.id}
                                    className="rounded-xl p-3"
                                    style={{
                                      background: "rgba(5,8,16,0.5)",
                                      border: "1px solid rgba(58,65,80,0.5)",
                                    }}
                                  >
                                    <div className="flex items-center justify-between mb-1">
                                      <code className="bv-mono" style={{ color: "var(--color-secondary-fixed-dim)", fontWeight: 500 }}>
                                        ⌖ {tc.toolName}
                                      </code>
                                      <div className="flex items-center gap-3">
                                        <span
                                          className="bv-micro"
                                          style={{ color: tc.status === "COMPLETED" ? "var(--bv-cobalt-glow)" : "var(--bv-status-failed)" }}
                                        >
                                          {tc.status}
                                        </span>
                                        <span className="bv-mono" style={{ color: "var(--bv-text-faint)" }}>{tc.durationMs}ms</span>
                                      </div>
                                    </div>
                                    {tc.input && (
                                      <details className="mt-1">
                                        <summary className="cursor-pointer bv-caption" style={{ color: "var(--bv-text-faint)" }}>
                                          {t("app.runDetail.inputLabel")}
                                        </summary>
                                        <pre
                                          className="mt-1 p-2 rounded-lg text-[11px] overflow-auto max-h-32"
                                          style={{ background: "rgba(0,0,0,0.25)", color: "var(--color-on-surface-variant)", fontFamily: "var(--bv-font-mono)" }}
                                        >
                                          {JSON.stringify(tc.input, null, 2)}
                                        </pre>
                                      </details>
                                    )}
                                    {tc.output && (
                                      <details className="mt-1">
                                        <summary className="cursor-pointer bv-caption" style={{ color: "var(--bv-text-faint)" }}>
                                          {t("app.runDetail.outputLabel")}
                                        </summary>
                                        <pre
                                          className="mt-1 p-2 rounded-lg text-[11px] overflow-auto max-h-32"
                                          style={{ background: "rgba(0,0,0,0.25)", color: "var(--color-on-surface-variant)", fontFamily: "var(--bv-font-mono)" }}
                                        >
                                          {JSON.stringify(tc.output, null, 2)}
                                        </pre>
                                      </details>
                                    )}
                                    {tc.error && (
                                      <p className="mt-1 bv-caption" style={{ color: "var(--bv-status-failed)" }}>{tc.error}</p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Step actions */}
                          <div className="flex gap-2">
                            {(step.status === "COMPLETED" || step.status === "FAILED") && (
                              <button
                                onClick={() => handleStepAction(step.id, "rollback")}
                                disabled={!!actionLoading}
                                className="bv-btn bv-btn-ghost bv-btn-sm disabled:opacity-50"
                              >
                                {t("app.runDetail.rollback")}
                              </button>
                            )}
                            {(step.status === "FAILED" || step.status === "ROLLED_BACK") && (
                              <button
                                onClick={() => handleStepAction(step.id, "rerun")}
                                disabled={!!actionLoading}
                                className="bv-btn bv-btn-primary bv-btn-sm disabled:opacity-50"
                              >
                                {t("app.runDetail.rerunStep")}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={timelineEndRef} />
          </div>
        </div>

        {/* ── RIGHT rail: run meta + cost gauge + actions ────── */}
        <div className="bv-twocol-side" style={{ position: "sticky", top: 84 }}>
          <div className="bv-glass bv-panel rounded-2xl">
            <h3 className="bv-micro" style={{ color: "var(--bv-text-faint)", marginBottom: 14 }}>Run meta</h3>

            {/* Meta rows */}
            {[
              { k: t("app.runDetail.status"),   v: run.status },
              { k: "Run ID",                     v: run.id },
              { k: "Pipeline",                   v: run.pipeline.name },
              { k: t("app.runDetail.steps"),     v: `${completedSteps} / ${run.steps.length}` },
              {
                k: t("app.runDetail.duration"),
                v: run.completedAt
                  ? `${(Math.max(0, new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000).toFixed(1)}s`
                  : isLive
                    ? `${(Math.max(0, Date.now() - new Date(run.createdAt).getTime()) / 1000).toFixed(0)}s`
                    : "—",
              },
            ].map(({ k, v }) => (
              <div
                key={k}
                className="flex justify-between items-center py-2"
                style={{ borderBottom: "1px solid rgba(35,40,51,0.5)", fontSize: 13.5 }}
              >
                <span style={{ color: "var(--color-on-surface-variant)" }}>{k}</span>
                <span
                  className="bv-mono"
                  style={{ color: "var(--color-on-surface)", fontSize: 12.5 }}
                >
                  {v}
                </span>
              </div>
            ))}

            {/* Cost vs budget gauge */}
            <div className="mt-5">
              <h3 className="bv-micro mb-3" style={{ color: "var(--bv-text-faint)" }}>
                {t("app.runDetail.cost")} vs budget
              </h3>
              <div
                className="rounded-md overflow-hidden mb-2"
                style={{ height: 10, background: "rgba(5,8,16,0.6)", border: "1px solid rgba(58,65,80,0.5)" }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${spendPct}%`,
                    background: spendPct > 80
                      ? "linear-gradient(90deg,var(--bv-cobalt-glow),var(--bv-status-failed))"
                      : "linear-gradient(90deg,var(--bv-cobalt-glow),var(--bv-status-running))",
                    borderRadius: 6,
                    transition: "width 1s cubic-bezier(0.4,0,0.2,1)",
                  }}
                />
              </div>
              <div className="flex justify-between bv-mono" style={{ fontSize: 11.5, color: "var(--color-on-surface-variant)" }}>
                <span>${Number(run.costUsd ?? 0).toFixed(2)}</span>
                <span>budget ${budgetUsd.toFixed(2)}</span>
              </div>
            </div>

            {/* Utility actions */}
            <div className="flex flex-col gap-2 mt-4">
              <button className="bv-btn bv-btn-ghost bv-btn-sm w-full justify-center">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>timeline</span>
                Timeline scrubber
              </button>
              <button className="bv-btn bv-btn-ghost bv-btn-sm w-full justify-center">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
                Export trail
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Docked steer composer (fixed bottom, live runs only) ── */}
      {isLive && (
        <div
          style={{
            position: "fixed",
            left: 248,
            right: 342,
            bottom: 0,
            zIndex: 30,
            padding: "16px 28px 22px",
            background: "linear-gradient(0deg,var(--color-background) 55%,transparent)",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              pointerEvents: "auto",
              display: "flex",
              gap: 12,
              alignItems: "flex-end",
              background: "linear-gradient(135deg,#171b24,#0d0f15)",
              border: "1px solid rgba(58,65,80,0.7)",
              borderRadius: 16,
              padding: 12,
              boxShadow: "0 24px 60px -20px rgba(0,0,0,0.9)",
              position: "relative",
            }}
          >
            {/* Label tag */}
            <span
              className="bv-micro"
              style={{
                position: "absolute",
                top: -10,
                left: 40,
                background: "var(--color-background)",
                padding: "0 8px",
                color: "var(--color-secondary-fixed-dim)",
              }}
            >
              Steer · inject guidance
            </span>
            <textarea
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSteer(); } }}
              placeholder={t("app.runDetail.steerPlaceholder")}
              rows={2}
              style={{
                flex: 1,
                background: "transparent",
                border: 0,
                outline: "none",
                color: "var(--color-on-surface)",
                fontSize: 14.5,
                resize: "none",
                padding: "11px 12px",
                lineHeight: 1.4,
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={handleSteer}
              disabled={steerBusy || !steerText.trim()}
              className="bv-btn bv-btn-primary disabled:opacity-50"
            >
              {steerBusy ? t("app.runDetail.sending") : t("app.runDetail.sendSteer")}
            </button>
          </div>
          {steerMsg && (
            <p
              className="bv-caption mt-2 text-center"
              style={{ color: steerOk ? "var(--bv-cobalt-glow)" : "var(--bv-status-failed)" }}
            >
              {steerMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
