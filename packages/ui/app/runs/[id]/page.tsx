"use client";

/**
 * /runs/[id] — single run detail with audit trail.
 *
 * Shows the full step-by-step record (RunStep + ToolCall) for a run.
 * Linked from /dashboard's Recent runs panel rows. Useful for the
 * "what did the agent actually do" question — the heart of the
 * audited-by-default value prop.
 */

import { useEffect, useState, useRef, forwardRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "../../../lib/api";
import { streamRun } from "../../../lib/runStream";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import { timeAgo } from "../../../lib/timeAgo";
import { RunStepHeatmap } from "../../../components/RunStepHeatmap";
import { useTranslations } from "next-intl";

interface RunDetail {
  id: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  costUsd?: number;
  budgetUsd?: number;
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
  const t = useTranslations();
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
    node.style.outline = "2px solid rgba(59,130,246,0.55)";
    node.style.outlineOffset = "2px";
    window.setTimeout(() => {
      node.style.outline = "";
      node.style.outlineOffset = "";
    }, 1400);
  };

  useEffect(() => {
    if (!token || !runId) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let stop: (() => void) | null = null;

    const load = () =>
      api.getRun(token, runId)
        .then((r) => { if (!cancelled) setRun(r); return r; })
        .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : t("app.runAudit.loadFailed")); return null; });

    setLoaded(false);
    void load().then((r) => {
      if (cancelled) return;
      setLoaded(true);
      const terminal = r && ["COMPLETED", "FAILED", "CANCELLED"].includes(String(r.status).toUpperCase());
      if (!r || terminal) return;
      stop = streamRun(token, runId, {
        onEvent: () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => { void load(); }, 350);
        },
        onDone: () => { void load(); },
      });
    });

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      if (stop) stop();
    };
  }, [token, runId]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#3B82F6" }}
        />
      </div>
    );
  }

  return (
    <div className="bv-dash bv-dash-shell">
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "24px 24px 120px",
        }}
      >
        {/* Breadcrumb */}
        <div style={{ marginBottom: 20 }}>
          <Link
            href="/runs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--color-on-surface-variant)",
              fontSize: 13,
              textDecoration: "none",
              transition: "color 200ms",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
            {t("app.runAudit.runsLink")}
          </Link>
        </div>

        {!loaded ? (
          <div className="animate-shimmer" style={{ height: 96, borderRadius: 16 }} />
        ) : err ? (
          <div className="bv-glass bv-panel" style={{ borderColor: "rgba(255,77,77,0.25)" }}>
            <p style={{ color: "var(--color-error, #FF4D4D)", margin: 0 }}>{err}</p>
          </div>
        ) : !run ? (
          <div className="bv-glass bv-panel">
            <p style={{ margin: 0 }}>{t("app.runAudit.notFound")}</p>
          </div>
        ) : (
          <>
            {/* ── Page head ── */}
            <div className="bv-page-head bv-rise" style={{ marginBottom: 28 }}>
              <div>
                <div className="bv-micro" style={{ marginBottom: 8 }}>{t("app.runAudit.auditTrail")}</div>
                <h1 className="bv-display" style={{ margin: 0, fontSize: 26 }}>
                  <span className="bv-grad-text">
                    {run.pipeline?.name ?? t("app.runAudit.pipelineFallback")}
                  </span>
                </h1>
                <div
                  className="bv-caption"
                  style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                >
                  <StatusLabel status={(run.status ?? "running").toLowerCase()} />
                  {run.pipeline?.company?.name && (
                    <>
                      <span className="bv-divider-dot" aria-hidden />
                      <span className="bv-mono">{run.pipeline.company.name}</span>
                    </>
                  )}
                  {run.startedAt && (
                    <>
                      <span className="bv-divider-dot" aria-hidden />
                      <span>{t("app.runAudit.startedAt", { time: timeAgo(run.startedAt) })}</span>
                    </>
                  )}
                  <span className="bv-divider-dot" aria-hidden />
                  <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11 }}>{run.id}</span>
                </div>
              </div>

              <div className="bv-page-head-actions">
                <button className="bv-btn bv-btn-ghost bv-btn-sm">
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>history</span>
                  Rollback
                </button>
                <button className="bv-btn bv-btn-ghost bv-btn-sm">
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>replay</span>
                  Rerun
                </button>
              </div>
            </div>

            {/* ── Error banner ── */}
            {run.error && (
              <div
                className="bv-glass bv-panel bv-risk-flash"
                style={{ marginBottom: 18, borderColor: "rgba(255,77,77,0.25)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="material-symbols-outlined" style={{ color: "#FF4D4D", fontSize: 18 }}>error</span>
                  <h2 className="bv-title" style={{ color: "#FF4D4D", margin: 0 }}>{t("app.runAudit.runError")}</h2>
                </div>
                <pre
                  className="bv-mono"
                  style={{ margin: 0, whiteSpace: "pre-wrap", color: "var(--color-on-surface-variant)", fontSize: 12 }}
                >
                  {run.error}
                </pre>
              </div>
            )}

            {/* ── Two-column layout: stream + rail ── */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 300px",
                gap: 22,
                alignItems: "start",
              }}
            >
              {/* ─── Left: stream column ─── */}
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>

                {/* Heatmap */}
                {run.steps && run.steps.length >= 2 && (
                  <div className="bv-glass bv-panel" style={{ gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-outline)" }}>bar_chart</span>
                      <span className="bv-micro">Cost heatmap</span>
                    </div>
                    <RunStepHeatmap
                      steps={run.steps}
                      totalCostUsd={run.costUsd}
                      onSelectStep={scrollToStep}
                    />
                  </div>
                )}

                {/* Steps stream */}
                <section className="bv-glass bv-panel">
                  <header className="bv-panel-head">
                    <div>
                      <h2 className="bv-title">{t("app.runAudit.stepsTitle")}</h2>
                      <div className="bv-caption">
                        {t("app.runAudit.stepCount", { n: run.steps?.length ?? 0 })}
                      </div>
                    </div>
                  </header>

                  {(!run.steps || run.steps.length === 0) ? (
                    <div
                      style={{
                        padding: "24px 0",
                        textAlign: "center",
                        color: "var(--color-outline)",
                        fontSize: 13,
                      }}
                    >
                      {t("app.runAudit.noSteps")}
                    </div>
                  ) : (
                    <ol
                      className="bv-stagger"
                      style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 0 }}
                    >
                      {run.steps.map((s, idx) => (
                        <StepNode
                          key={s.id}
                          s={s}
                          idx={idx}
                          isLast={idx === (run.steps?.length ?? 0) - 1}
                          ref={(el: HTMLLIElement | null) => {
                            if (el) stepRefs.current.set(s.id, el);
                            else stepRefs.current.delete(s.id);
                          }}
                          t={t}
                        />
                      ))}
                    </ol>
                  )}
                </section>

                {/* Approvals */}
                {run.approvals && run.approvals.length > 0 && (
                  <section className="bv-glass bv-panel">
                    <header className="bv-panel-head">
                      <div>
                        <h2 className="bv-title">{t("app.runAudit.approvalsTitle")}</h2>
                        <div className="bv-caption">{t("app.runAudit.approvalCount", { n: run.approvals.length })}</div>
                      </div>
                    </header>
                    <ul className="bv-approval-list">
                      {run.approvals.map((a) => (
                        <li key={a.id} className="bv-approval-item">
                          <span className="bv-approval-icon" aria-hidden>
                            <span className="material-symbols-outlined">approval</span>
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div className="bv-approval-title">
                              {a.description ?? a.type ?? t("app.runAudit.approvalFallback")}
                            </div>
                            <div className="bv-approval-meta bv-mono">{a.status}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              {/* ─── Right: meta rail ─── */}
              <div style={{ position: "sticky", top: 84 }}>
                <div className="bv-glass bv-panel" style={{ gap: 0 }}>
                  {/* Run meta section */}
                  <div className="bv-micro" style={{ marginBottom: 14 }}>Run meta</div>

                  <MetaRow label="Run ID" value={run.id} mono />
                  <MetaRow label="Pipeline" value={run.pipeline?.name ?? "—"} mono />
                  <MetaRow
                    label="Steps"
                    value={`${run.steps?.filter(s => ["completed","failed","cancelled"].includes(s.status.toLowerCase())).length ?? 0} / ${run.steps?.length ?? 0}`}
                    mono
                  />
                  <MetaRow
                    label="Approvals"
                    value={String(run.approvals?.length ?? 0)}
                    mono
                  />
                  {run.startedAt && (
                    <MetaRow label="Duration" value={timeAgo(run.startedAt)} />
                  )}

                  {/* Cost gauge */}
                  {typeof run.costUsd === "number" && (
                    <>
                      <div
                        className="bv-micro"
                        style={{ marginTop: 20, marginBottom: 12 }}
                      >
                        Cost vs budget
                      </div>
                      <CostGauge
                        costUsd={run.costUsd}
                        budgetUsd={run.budgetUsd ?? 50}
                      />
                    </>
                  )}

                  {/* Actions */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      marginTop: 18,
                    }}
                  >
                    <button
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 15 }}>timeline</span>
                      Timeline scrubber
                    </button>
                    <button
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 15 }}>download</span>
                      Export trail
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Docked steer composer (running only) ── */}
            {run.status.toLowerCase() === "running" && (
              <SteerDock runId={run.id} token={token} />
            )}
          </>
        )}
      </div>

      {/* Responsive overrides */}
      <style>{`
        @media (max-width: 1100px) {
          .run-twocol { grid-template-columns: 1fr !important; }
          .run-rail   { position: static !important; }
        }
      `}</style>
    </div>
  );
}

/* ── Step node with vertical rail line ── */
interface StepNodeProps {
  s: {
    id: string;
    stepIndex: number;
    agentRole?: string;
    name?: string;
    status: string;
    reasoning?: string;
    costUsd?: number | string | null;
    durationMs?: number;
    toolCalls?: Array<{ id: string; toolName: string; status: string; durationMs?: number; error?: string | null }>;
  };
  idx: number;
  isLast: boolean;
  t: ReturnType<typeof useTranslations>;
}

const StepNode = forwardRef<HTMLLIElement, StepNodeProps>(function StepNode({ s, idx, isLast, t }, ref) {
  const [open, setOpen] = useState(false);
  const isRunning = s.status.toLowerCase() === "running";
  const isFailed  = s.status.toLowerCase() === "failed";

  return (
    <li
      ref={ref}
      style={{
        display: "grid",
        gridTemplateColumns: "34px 1fr",
        gap: 16,
        position: "relative",
        transition: "outline 0.3s ease-out, outline-offset 0.3s ease-out",
      }}
    >
      {/* Rail node */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--color-background)",
            border: `2px solid ${isRunning ? "var(--bv-status-running)" : isFailed ? "var(--bv-status-failed)" : "var(--bv-status-completed)"}`,
            boxShadow: isRunning ? "0 0 10px var(--bv-status-running)" : isFailed ? "0 0 8px var(--bv-status-failed)" : "none",
            flexShrink: 0,
            marginTop: 18,
            zIndex: 2,
            position: "relative",
          }}
        >
          {isRunning && (
            <span
              style={{
                position: "absolute",
                inset: -5,
                borderRadius: "50%",
                border: "1px solid var(--bv-status-running)",
                animation: "bv-status-ping 2s var(--bv-ease-out) infinite",
              }}
            />
          )}
        </div>
        {!isLast && (
          <div
            style={{
              flex: 1,
              width: 2,
              marginTop: 4,
              background: "linear-gradient(180deg, rgba(59,130,246,0.5), rgba(59,130,246,0.08))",
              minHeight: 24,
            }}
          />
        )}
      </div>

      {/* Card */}
      <div
        style={{
          marginBottom: isLast ? 0 : 18,
          padding: "14px 16px",
          borderRadius: 14,
          background: isRunning
            ? "linear-gradient(135deg,rgba(59,130,246,0.06),transparent)"
            : isFailed
            ? "linear-gradient(135deg,rgba(255,77,77,0.06),transparent)"
            : "rgba(255,255,255,0.02)",
          border: `1px solid ${isRunning ? "rgba(59,130,246,0.3)" : isFailed ? "rgba(255,77,77,0.25)" : "var(--bv-glass-border)"}`,
          transition: "border-color 0.2s",
        }}
      >
        {/* Top row: agent · badge · cost */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <span
            className="bv-mono"
            style={{ fontSize: 11.5, letterSpacing: "0.05em", color: "#60A5FA" }}
          >
            {s.agentRole ?? t("app.runAudit.agentFallback")}
          </span>

          {isRunning && (
            <span className="bv-pill bv-pill-cyan">streaming</span>
          )}

          <span className="bv-pill bv-pill-muted">step {idx + 1}</span>

          <StatusLabel status={s.status.toLowerCase()} />

          {(s.costUsd != null && s.costUsd !== "") && (
            <span
              className="bv-mono"
              style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--color-outline)" }}
            >
              ${typeof s.costUsd === "number" ? s.costUsd.toFixed(4) : s.costUsd}
            </span>
          )}
        </div>

        {/* Reasoning */}
        {s.reasoning && (
          <p
            style={{
              margin: 0,
              fontSize: 14,
              color: "var(--color-on-surface)",
              lineHeight: 1.55,
              marginBottom: s.toolCalls && s.toolCalls.length > 0 ? 10 : 0,
            }}
          >
            {s.reasoning}
          </p>
        )}

        {/* Tool calls */}
        {s.toolCalls && s.toolCalls.length > 0 && (
          <div>
            <button
              onClick={() => setOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                background: "rgba(5,6,10,0.6)",
                border: "1px solid var(--bv-glass-border)",
                borderRadius: 10,
                padding: "8px 12px",
                color: "var(--color-on-surface-variant)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "var(--bv-font-mono)",
                marginTop: 2,
              }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 14, color: "#7DD3FC" }}
              >
                terminal
              </span>
              <span style={{ color: "#7DD3FC" }}>⌖</span>
              <span style={{ flex: 1, textAlign: "left" }}>
                {s.toolCalls[0].toolName}
                {s.toolCalls.length > 1 ? ` +${s.toolCalls.length - 1} more` : ""}
              </span>
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: 14,
                  color: "var(--color-outline)",
                  transform: open ? "rotate(90deg)" : "none",
                  transition: "transform 0.25s",
                }}
              >
                chevron_right
              </span>
            </button>

            {open && (
              <ul
                style={{
                  listStyle: "none",
                  padding: "10px 12px",
                  margin: 0,
                  background: "rgba(5,6,10,0.9)",
                  border: "1px solid var(--bv-glass-border)",
                  borderTop: 0,
                  borderRadius: "0 0 10px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {s.toolCalls.map((tc) => (
                  <li
                    key={tc.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.03)",
                      fontSize: 12,
                    }}
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 14, color: "var(--color-outline)" }}
                    >
                      build
                    </span>
                    <span className="bv-mono">{tc.toolName}</span>
                    <StatusLabel status={(tc.status ?? "completed").toLowerCase()} />
                    {tc.durationMs != null && (
                      <span
                        className="bv-mono"
                        style={{ color: "var(--color-outline)", marginLeft: "auto" }}
                      >
                        {(tc.durationMs / 1000).toFixed(2)}s
                      </span>
                    )}
                    {tc.error && (
                      <span style={{ color: "#FF4D4D", fontSize: 11, marginLeft: 6 }}>
                        {tc.error}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Duration */}
        {s.durationMs != null && (
          <div
            className="bv-mono"
            style={{ fontSize: 11, color: "var(--color-outline)", marginTop: 8 }}
          >
            {(s.durationMs / 1000).toFixed(2)}s
          </div>
        )}
      </div>
    </li>
  );
});

/* ── Meta row (right rail) ── */
function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "7px 0",
        borderBottom: "1px solid rgba(35,40,51,0.5)",
        fontSize: 13,
        gap: 8,
      }}
    >
      <span style={{ color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        className={mono ? "bv-mono" : undefined}
        style={{ color: "var(--color-on-surface)", fontSize: mono ? 12 : 13, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "60%" }}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Cost gauge ── */
function CostGauge({ costUsd, budgetUsd }: { costUsd: number; budgetUsd: number }) {
  const pct = Math.min((costUsd / budgetUsd) * 100, 100);
  const overHalf = pct > 60;
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          height: 10,
          borderRadius: 6,
          background: "rgba(5,6,10,0.8)",
          border: "1px solid var(--bv-glass-border)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: overHalf
              ? "linear-gradient(90deg, #3B82F6, #FF7A1A)"
              : "linear-gradient(90deg, #3B82F6, #2563EB)",
            borderRadius: 6,
            transition: "width 1s cubic-bezier(0.16,1,0.3,1)",
          }}
        />
      </div>
      <div
        className="bv-mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--color-outline)",
          marginTop: 8,
        }}
      >
        <span>${costUsd.toFixed(2)}</span>
        <span>budget ${budgetUsd.toFixed(2)}</span>
      </div>
    </div>
  );
}

/* ── Docked steer composer (shown when run is live) ── */
function SteerDock({ runId, token }: { runId: string; token: string }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const v = value.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      // api.steerRun is an optional extension; no-op if not yet defined
      await (api as unknown as { steerRun?: (t: string, id: string, msg: string) => Promise<void> }).steerRun?.(token, runId, v);
      setValue("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        left: 248,
        right: 24,
        bottom: 0,
        zIndex: 30,
        padding: "16px 28px 22px",
        background: "linear-gradient(0deg, var(--color-background) 55%, transparent)",
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
          border: "1px solid rgba(58,65,80,0.8)",
          borderRadius: 16,
          padding: 12,
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.9)",
          position: "relative",
        }}
      >
        {/* Tag */}
        <span
          className="bv-mono"
          style={{
            position: "absolute",
            top: -10,
            left: 40,
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "#7DD3FC",
            background: "var(--color-background)",
            padding: "0 8px",
          }}
        >
          Steer · inject guidance
        </span>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          placeholder={"Inject guidance into the agent's next turn… (e.g. \"only contact companies with >50 employees\")"}
          rows={1}
          style={{
            flex: 1,
            background: "transparent",
            border: 0,
            outline: "none",
            color: "var(--color-on-surface)",
            fontSize: 14,
            resize: "none",
            padding: "10px 12px",
            lineHeight: 1.4,
            fontFamily: "var(--bv-font-body)",
          }}
        />

        <button
          className="bv-btn bv-btn-primary"
          onClick={() => void submit()}
          disabled={sending || !value.trim()}
          style={{ flexShrink: 0 }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>send</span>
          Steer
        </button>
      </div>
    </div>
  );
}

/* ── Status label (dot + text) ── */
function StatusLabel({ status }: { status: string }) {
  const t = useTranslations();
  const label =
    status === "running"          ? t("app.runAudit.statusRunning") :
    status === "completed"        ? t("app.runAudit.statusCompleted") :
    status === "paused"           ? t("app.runAudit.statusPaused") :
    status === "failed"           ? t("app.runAudit.statusFailed") :
    status === "cancelled"        ? t("app.runAudit.statusCancelled") :
    status === "waiting_approval" ? t("app.runAudit.statusWaiting") :
    t("app.runAudit.statusPending");

  const dotCls =
    status === "waiting_approval" || status === "pending" ? "bv-pending" : status;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className={`bv-dot bv-${dotCls}${status === "running" ? " bv-ping" : ""}`}
        aria-hidden
      />
      <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
}
