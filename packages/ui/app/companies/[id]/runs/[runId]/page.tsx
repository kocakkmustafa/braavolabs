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

  if (!token) return <p style={{ color: "#859399", padding: 32 }}>{t("app.runDetail.loginFirst")}</p>;
  if (error) return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171", padding: 16, borderRadius: 12 }}>{error}</div>
    </div>
  );
  if (!run) return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <div className="animate-shimmer" style={{ height: 32, width: 192, borderRadius: 8, background: "rgba(255,255,255,0.06)", marginBottom: 16 }} />
      <div className="animate-shimmer" style={{ height: 128, borderRadius: 16, background: "rgba(255,255,255,0.04)" }} />
    </div>
  );

  const runSt = STATUS_STYLES[run.status] ?? DEFAULT_STATUS;
  const isLive = LIVE_STATUSES.includes(run.status);
  const pendingInput = (run.approvals ?? []).filter((a) => a.type === "INPUT" && a.status === "PENDING");
  const completedSteps = run.steps.filter((s) => s.status === "COMPLETED").length;
  const progressPct = run.steps.length > 0 ? Math.round((completedSteps / run.steps.length) * 100) : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold" style={{ color: "#e1e2eb" }}>{t("app.runDetail.title")}</h1>
          <p className="text-sm mt-1" style={{ color: "#859399" }}>
            {run.pipeline.company.name} / {run.pipeline.name}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Live indicator */}
          {isLive && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.15)" }}>
              <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: "#00d1ff", boxShadow: "0 0 6px #00d1ff" }} />
              <span className="text-xs font-semibold" style={{ color: "#00d1ff" }}>{t("app.runDetail.live")}</span>
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className="ml-1"
                title={autoRefresh ? t("app.runDetail.pauseRefresh") : t("app.runDetail.resumeRefresh")}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: autoRefresh ? "#00d1ff" : "#3c494e" }}>
                  {autoRefresh ? "pause" : "play_arrow"}
                </span>
              </button>
            </div>
          )}

          {run.status === "RUNNING" && (
            <>
              <button
                onClick={() => handleAction("pause")}
                disabled={!!actionLoading}
                className="px-4 py-2 rounded-xl text-xs font-semibold disabled:opacity-50"
                style={{ background: "rgba(251,191,36,0.1)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.2)" }}
              >
                {t("app.runDetail.pause")}
              </button>
              <button
                onClick={() => handleAction("stop")}
                disabled={!!actionLoading}
                className="px-4 py-2 rounded-xl text-xs font-semibold disabled:opacity-50"
                style={{ background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }}
              >
                {t("app.runDetail.hardStop")}
              </button>
            </>
          )}
          {run.status === "PAUSED" && (
            <button
              onClick={() => handleAction("resume")}
              disabled={!!actionLoading}
              className="px-4 py-2 rounded-xl text-xs font-semibold disabled:opacity-50 text-white"
              style={{ background: "#34d399" }}
            >
              {t("app.runDetail.resume")}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar for live runs */}
      {isLive && (
        <div className="mb-6">
          <div className="flex justify-between mb-1">
            <span className="text-xs" style={{ color: "#859399" }}>{t("app.runDetail.stepProgress", { done: completedSteps, total: run.steps.length })}</span>
            <span className="text-xs font-bold" style={{ color: "#00d1ff" }}>{progressPct}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progressPct}%`, background: "linear-gradient(90deg, #00d1ff, #6d11ad)", transition: "width 0.5s ease" }}
            />
          </div>
        </div>
      )}

      {/* Run Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <div className="glass-card rounded-xl p-4">
          <p className="text-[10px] font-semibold tracking-wider mb-2" style={{ color: "#859399" }}>{t("app.runDetail.status")}</p>
          <span className="inline-block px-2.5 py-1 rounded-lg text-xs font-semibold" style={{ background: runSt.bg, color: runSt.color, border: runSt.border }}>
            {run.status}
          </span>
        </div>
        <div className="glass-card rounded-xl p-4">
          <p className="text-[10px] font-semibold tracking-wider mb-1" style={{ color: "#859399" }}>{t("app.runDetail.steps")}</p>
          <p className="text-xl font-bold font-headline" style={{ color: "#e1e2eb" }}>{run.steps.length}</p>
        </div>
        <div className="glass-card rounded-xl p-4">
          <p className="text-[10px] font-semibold tracking-wider mb-1" style={{ color: "#859399" }}>{t("app.runDetail.cost")}</p>
          <p className="text-xl font-bold font-headline" style={{ color: "#e1e2eb" }}>${Number(run.costUsd ?? 0).toFixed(4)}</p>
        </div>
        <div className="glass-card rounded-xl p-4">
          <p className="text-[10px] font-semibold tracking-wider mb-1" style={{ color: "#859399" }}>{t("app.runDetail.duration")}</p>
          <p className="text-xl font-bold font-headline" style={{ color: "#e1e2eb" }}>
            {run.completedAt
              ? `${(Math.max(0, new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000).toFixed(1)}s`
              : isLive
                ? `${(Math.max(0, Date.now() - new Date(run.createdAt).getTime()) / 1000).toFixed(0)}s`
                : "—"}
          </p>
        </div>
      </div>

      {/* Run-level error banner — surfaces the failure reason at a glance so
          users don't have to expand every step to find what broke. Backed by
          run.error, which is now populated from the first failed step in
          runner.ts (was previously null on FAILED runs). */}
      {run.status === "FAILED" && run.error && (
        <div
          className="rounded-xl p-4 mb-6"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
          }}
          role="alert"
        >
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: 20, color: "#f87171" }}>
              error
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-wider mb-1" style={{ color: "#f87171" }}>
                {t("app.runDetail.runFailed")}
              </p>
              <p className="text-sm whitespace-pre-wrap break-words" style={{ color: "#fecaca" }}>
                {run.error}
              </p>
              {/* Lightweight remediation hints — pattern-matched on common
                  failure modes so the user knows the next click. */}
              {run.error.toLowerCase().includes("api") && run.error.toLowerCase().includes("key") && (
                <a
                  href="/settings#ai_provider"
                  className="inline-block mt-3 text-xs font-semibold underline"
                  style={{ color: "#fca5a5" }}
                >
                  {t("app.runDetail.remSettings")}
                </a>
              )}
              {run.error.toLowerCase().includes("quota") && (
                <a
                  href="/billing"
                  className="inline-block mt-3 text-xs font-semibold underline"
                  style={{ color: "#fca5a5" }}
                >
                  {t("app.runDetail.remBilling")}
                </a>
              )}
              {run.error.toLowerCase().includes("approval") && (
                <a
                  href="/approvals"
                  className="inline-block mt-3 text-xs font-semibold underline"
                  style={{ color: "#fca5a5" }}
                >
                  {t("app.runDetail.remApprovals")}
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Agent → human: the run is paused on an ask_user question. Answer it
          and the run resumes with the answer delivered to the agent. */}
      {pendingInput.length > 0 && (
        <div className="glass-card rounded-xl p-4 mb-6" style={{ border: "1px solid rgba(251,146,60,0.35)", background: "rgba(251,146,60,0.06)" }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#fb923c" }}>contact_support</span>
            <h3 className="text-sm font-semibold" style={{ color: "#fb923c" }}>{t("app.runDetail.inputTitle")}</h3>
          </div>
          <p className="text-sm mb-3" style={{ color: "#e1e2eb", whiteSpace: "pre-wrap" }}>{pendingInput[0].description}</p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t("app.runDetail.answerPlaceholder")}
            rows={3}
            className="w-full rounded-lg p-3 text-sm outline-none mb-2"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb", resize: "vertical" }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: answerOk ? "#34d399" : "#f87171" }}>{answerMsg ?? ""}</span>
            <button
              onClick={() => handleAnswer(pendingInput[0].id)}
              disabled={answerBusy || !answer.trim()}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: "#fb923c" }}
            >
              {answerBusy ? t("app.runDetail.sending") : t("app.runDetail.sendAnswer")}
            </button>
          </div>
        </div>
      )}

      {/* Mid-run steering — the v2 moat. Redirect a live agent without
          stopping it; the message is injected on the agent's next turn. */}
      {isLive && (
        <div className="glass-card rounded-xl p-4 mb-6" style={{ border: "1px solid rgba(0,209,255,0.15)" }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#00d1ff" }}>alt_route</span>
            <h3 className="text-sm font-semibold" style={{ color: "#e1e2eb" }}>{t("app.runDetail.steerTitle")}</h3>
          </div>
          <p className="text-xs mb-3" style={{ color: "#859399" }}>
            {t("app.runDetail.steerHelp")}
          </p>
          <textarea
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            placeholder={t("app.runDetail.steerPlaceholder")}
            rows={2}
            className="w-full rounded-lg p-3 text-sm outline-none mb-2"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb", resize: "vertical" }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: steerOk ? "#34d399" : "#f87171" }}>{steerMsg ?? ""}</span>
            <button
              onClick={handleSteer}
              disabled={steerBusy || !steerText.trim()}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
            >
              {steerBusy ? t("app.runDetail.sending") : t("app.runDetail.sendSteer")}
            </button>
          </div>
        </div>
      )}

      {/* Step Timeline */}
      <h2 className="text-sm font-semibold mb-4" style={{ color: "#e1e2eb" }}>{t("app.runDetail.timeline")}</h2>
      <div className="flex flex-col gap-3">
        {run.steps.map((step, idx) => {
          const st = STATUS_STYLES[step.status] ?? DEFAULT_STATUS;
          const dotColor = STEP_DOT_COLORS[step.status] ?? "#3c494e";
          const isRunning = step.status === "RUNNING";
          return (
            <div
              key={step.id}
              className="glass-card rounded-xl overflow-hidden"
              style={{ borderLeft: `3px solid ${dotColor}` }}
            >
              {/* Step Header */}
              <button
                onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
                className="w-full flex items-center gap-3 sm:gap-4 p-4 text-left border-none cursor-pointer transition-colors"
                style={{ background: "transparent" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div className="flex flex-col items-center flex-shrink-0">
                  <div
                    className={isRunning ? "animate-pulse" : ""}
                    style={{
                      width: 12, height: 12, borderRadius: "50%",
                      background: dotColor,
                      boxShadow: isRunning ? `0 0 8px ${dotColor}` : "none",
                    }}
                  />
                  {idx < run.steps.length - 1 && (
                    <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.06)", marginTop: 4 }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm" style={{ color: "#e1e2eb" }}>{step.name}</span>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold" style={{ background: st.bg, color: st.color, border: st.border }}>
                      {step.status}
                    </span>
                  </div>
                  {step.reasoning && (
                    <p className="text-xs mt-1 truncate" style={{ color: "#859399" }}>{step.reasoning}</p>
                  )}
                </div>

                <div className="text-right text-xs flex-shrink-0 hidden sm:block" style={{ color: "#859399" }}>
                  <div>${Number(step.costUsd ?? 0).toFixed(4)}</div>
                  <div>{t("app.runDetail.toolCallCount", { n: step.toolCalls.length })}</div>
                </div>

                <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "#3c494e", transform: expandedStep === step.id ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                  expand_more
                </span>
              </button>

              {/* Expanded Detail */}
              {expandedStep === step.id && (
                <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: 16 }}>
                  {step.reasoning && (
                    <div className="mb-4">
                      <h4 className="text-[10px] font-semibold tracking-wider mb-2" style={{ color: "#859399" }}>{t("app.runDetail.reasoning")}</h4>
                      <p className="text-xs rounded-xl p-3 whitespace-pre-wrap" style={{ color: "#bbc9cf", background: "rgba(0,209,255,0.04)", border: "1px solid rgba(0,209,255,0.08)" }}>
                        {step.reasoning}
                      </p>
                    </div>
                  )}

                  {step.error && (
                    <div className="mb-4">
                      <h4 className="text-[10px] font-semibold tracking-wider mb-2" style={{ color: "#f87171" }}>{t("app.runDetail.errorLabel")}</h4>
                      <p className="text-xs rounded-xl p-3" style={{ color: "#f87171", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                        {step.error}
                      </p>
                    </div>
                  )}

                  {step.toolCalls.length > 0 && (
                    <div className="mb-4">
                      <h4 className="text-[10px] font-semibold tracking-wider mb-2" style={{ color: "#859399" }}>{t("app.runDetail.toolCalls")}</h4>
                      <div className="flex flex-col gap-2">
                        {step.toolCalls.map((tc) => (
                          <div key={tc.id} className="rounded-xl p-3 text-xs" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <div className="flex items-center justify-between mb-1">
                              <code style={{ fontWeight: 500, color: "#bbc9cf" }}>{tc.toolName}</code>
                              <div className="flex items-center gap-2">
                                <span style={{ color: tc.status === "COMPLETED" ? "#34d399" : "#f87171" }}>{tc.status}</span>
                                <span style={{ color: "#3c494e" }}>{tc.durationMs}ms</span>
                              </div>
                            </div>
                            {tc.input && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs" style={{ color: "#859399" }}>{t("app.runDetail.inputLabel")}</summary>
                                <pre className="mt-1 p-2 rounded-lg text-[11px] overflow-auto max-h-32" style={{ background: "rgba(0,0,0,0.2)", color: "#bbc9cf" }}>
                                  {JSON.stringify(tc.input, null, 2)}
                                </pre>
                              </details>
                            )}
                            {tc.output && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs" style={{ color: "#859399" }}>{t("app.runDetail.outputLabel")}</summary>
                                <pre className="mt-1 p-2 rounded-lg text-[11px] overflow-auto max-h-32" style={{ background: "rgba(0,0,0,0.2)", color: "#bbc9cf" }}>
                                  {JSON.stringify(tc.output, null, 2)}
                                </pre>
                              </details>
                            )}
                            {tc.error && <p className="mt-1" style={{ color: "#f87171" }}>{tc.error}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Step Actions */}
                  <div className="flex gap-2">
                    {(step.status === "COMPLETED" || step.status === "FAILED") && (
                      <button
                        onClick={() => handleStepAction(step.id, "rollback")}
                        disabled={!!actionLoading}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                        style={{ border: "1px solid rgba(255,255,255,0.08)", color: "#859399", background: "transparent" }}
                      >
                        {t("app.runDetail.rollback")}
                      </button>
                    )}
                    {(step.status === "FAILED" || step.status === "ROLLED_BACK") && (
                      <button
                        onClick={() => handleStepAction(step.id, "rerun")}
                        disabled={!!actionLoading}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 text-white"
                        style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
                      >
                        {t("app.runDetail.rerunStep")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div ref={timelineEndRef} />
      </div>
    </div>
  );
}
