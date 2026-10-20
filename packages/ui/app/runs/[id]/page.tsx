"use client";
import { useDisplayFormats } from "../../../lib/useDisplayFormats";

import { useLocale as useRelativeLocale } from "next-intl";

import { useLocalizedFailure } from "../../../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


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
import BrandMotion from "../../../components/BrandMotion";
import { runMotion } from "../../../lib/brandMotion";
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
  const relativeLocale = useRelativeLocale();
  const describeFailure = useLocalizedFailure();
  const uiText = useLegacyTranslations("uiCopy");
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stepRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  // AI failure explanation (D2)
  const [explain, setExplain] = useState<{ explanation: string; suggestedFix: string; model?: string } | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainErr, setExplainErr] = useState<string | null>(null);

  const runExplain = async () => {
    if (!token || !runId || explainLoading) return;
    setExplainLoading(true);
    setExplainErr(null);
    try {
      const res = await api.explainRun(token, runId);
      setExplain({ explanation: res.explanation, suggestedFix: res.suggestedFix, model: res.model });
    } catch (e) {
      setExplainErr(describeFailure(e, t("app.runExplain.error")));
    } finally {
      setExplainLoading(false);
    }
  };

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
        .catch((e) => { if (!cancelled) setErr(describeFailure(e, t("app.runAudit.loadFailed"))); return null; });

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
                  <BrandMotion
                    state={runMotion(run.status, run.approvals?.some((approval) => approval.status === "PENDING"))}
                    size={40}
                  />
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
                      <span>{t("app.runAudit.startedAt", { time: timeAgo(run.startedAt, relativeLocale) })}</span>
                    </>
                  )}
                  <span className="bv-divider-dot" aria-hidden />
                  <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11 }}>{run.id}</span>
                </div>
              </div>

              <div className="bv-page-head-actions">
                <button className="bv-btn bv-btn-ghost bv-btn-sm">
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>history</span>{uiText("m9ce742313269")}</button>
                <button className="bv-btn bv-btn-ghost bv-btn-sm">
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>replay</span>{uiText("mc191d4f884e6")}</button>
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

                {/* Action row: AI explain (D2) + fix-in-editor */}
                <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {run.status?.toUpperCase() === "FAILED" && (
                    <button
                      onClick={() => void runExplain()}
                      disabled={explainLoading}
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                    >
                      {explainLoading ? (
                        <span
                          className="inline-block border-2 border-t-transparent rounded-full animate-spin"
                          style={{ width: 13, height: 13, borderWidth: 2, borderColor: "rgba(96,165,250,0.4)", borderTopColor: "transparent" }}
                        />
                      ) : (
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_awesome</span>
                      )}
                      {explainLoading ? t("app.runExplain.loading") : t("app.runExplain.button")}
                    </button>
                  )}
                  {run.pipeline?.id && (
                    <Link
                      href={`/pipelines/${run.pipeline.id}`}
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                      style={{ textDecoration: "none" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                      {t("app.runAudit.fixInEditor")}
                    </Link>
                  )}
                </div>

                {/* AI explanation result — calm panel below the raw error */}
                {explainErr && (
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 12.5,
                      color: "var(--color-on-surface-variant)",
                    }}
                  >
                    {explainErr}
                  </div>
                )}
                {explain && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: "14px 16px",
                      borderRadius: 12,
                      background: "rgba(59,130,246,0.06)",
                      border: "1px solid rgba(59,130,246,0.22)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 15, color: "var(--color-primary)" }}>auto_awesome</span>
                      <span
                        className="bv-mono"
                        style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-primary)" }}
                      >
                        {t("app.runExplain.title")}
                      </span>
                      {explain.model && (
                        <span style={{ fontSize: 10.5, color: "var(--color-outline)" }}>
                          {t("app.runExplain.poweredBy", { model: explain.model })}
                        </span>
                      )}
                    </div>
                    <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--color-on-surface)" }}>
                      {explain.explanation}
                    </p>
                    {explain.suggestedFix && (
                      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 15, color: "var(--color-primary)", marginTop: 1 }}>build</span>
                        <div>
                          <div
                            className="bv-mono"
                            style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-outline)", marginBottom: 2 }}
                          >
                            {t("app.runExplain.fixLabel")}
                          </div>
                          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--color-on-surface)" }}>
                            {explain.suggestedFix}
                          </p>
                        </div>
                      </div>
                    )}
                    <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--color-outline)", fontStyle: "italic" }}>
                      {t("app.runExplain.disclaimer")}
                    </div>
                  </div>
                )}
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
                      <span className="bv-micro">{uiText("mb9b248228c25")}</span>
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

                {/* Cross-model handoff (E3/T8) — request a handoff or, when an
                    OPEN ledger exists, continue the run on another provider.
                    Rendered for any non-terminal-or-failed run; the panel
                    itself decides which affordance to show from the ledger. */}
                {run.status && ["running", "paused", "waiting_approval", "failed"].includes(run.status.toLowerCase()) && (
                  <HandoffPanel runId={run.id} runStatus={run.status.toLowerCase()} token={token} t={t} />
                )}

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
                  <div className="bv-micro" style={{ marginBottom: 14 }}>{uiText("md4fdc87efd1b")}</div>

                  <MetaRow label={uiText("ma3d0dc878de8")} value={run.id} mono />
                  <MetaRow label={uiText("m83d38e678178")} value={run.pipeline?.name ?? "—"} mono />
                  <MetaRow
                    label={uiText("m89200cc22850")}
                    value={`${run.steps?.filter(s => ["completed","failed","cancelled"].includes(s.status.toLowerCase())).length ?? 0} / ${run.steps?.length ?? 0}`}
                    mono
                  />
                  <MetaRow
                    label={uiText("ma8322509bd8f")}
                    value={String(run.approvals?.length ?? 0)}
                    mono
                  />
                  {run.startedAt && (
                    <MetaRow label={uiText("m1eadff0f7d6b")} value={timeAgo(run.startedAt, relativeLocale)} />
                  )}

                  {/* Burn meter (D3) — live spend, honestly labelled. Budget
                      bar only renders when a real budget exists on the run. */}
                  {typeof run.costUsd === "number" && (
                    <>
                      <div
                        className="bv-micro"
                        style={{ marginTop: 20, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}
                      >
                        {t("app.cost.burnTitle")}
                        {run.status?.toLowerCase() === "running" && (
                          <span className="bv-pill bv-pill-cyan" style={{ fontSize: 9 }}>
                            {t("app.cost.burnLiveBadge")}
                          </span>
                        )}
                      </div>
                      <BurnMeter
                        costUsd={run.costUsd}
                        budgetUsd={typeof run.budgetUsd === "number" ? run.budgetUsd : null}
                        t={t}
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
                      <span className="material-symbols-outlined" style={{ fontSize: 15 }}>timeline</span>{uiText("m8905a490325a")}</button>
                    <button
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 15 }}>download</span>{uiText("m1dbbdb0c26b5")}</button>
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
  const displayFormat = useDisplayFormats();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
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
            style={{ fontSize: 11.5, letterSpacing: "0.05em", color: "var(--color-primary)" }}
          >
            {s.agentRole ?? t("app.runAudit.agentFallback")}
          </span>

          {isRunning && (
            <span className="bv-pill bv-pill-cyan">{uiText("mcf98748ad579")}</span>
          )}

          <span className="bv-pill bv-pill-muted">{uiText("mc3041e2d2f2b")}{" "}{idx + 1}</span>

          <StatusLabel status={s.status.toLowerCase()} />

          {(s.costUsd != null && s.costUsd !== "") && (
            <span
              className="bv-mono"
              style={{ marginInlineStart: "auto", fontSize: 11.5, color: "var(--color-outline)" }}
            >
              {displayFormat.usd(s.costUsd)}
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
                background: "var(--color-surface-container-low)",
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
              <span style={{ flex: 1, textAlign: "start" }}>
                {s.toolCalls[0].toolName}
                {s.toolCalls.length > 1 ? runtimeCopy("m1e3a5507bb67", { value0: s.toolCalls.length - 1 }) : ""}
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
                  background: "var(--color-surface-container-low)",
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
                        style={{ color: "var(--color-outline)", marginInlineStart: "auto" }}
                      >
                        {displayFormat.duration(tc.durationMs)}
                      </span>
                    )}
                    {tc.error && (
                      <span style={{ color: "#FF4D4D", fontSize: 11, marginInlineStart: 6 }}>
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
            {displayFormat.duration(s.durationMs)}
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
        style={{ color: "var(--color-on-surface)", fontSize: mono ? 12 : 13, textAlign: "end", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "60%" }}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Burn meter (D3) ──────────────────────────────────────────────────────
 * Live spend on the run. When the run carries a real budget, a thin bar
 * shows costUsd/budgetUsd with FORGE colouring: arc-blue under budget,
 * ember nearing it, molten over. Honest by construction — no invented
 * budget; if there's no budget we just show the live figure, no bar. */
function BurnMeter({
  costUsd,
  budgetUsd,
  t,
}: {
  costUsd: number;
  budgetUsd: number | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const displayFormat = useDisplayFormats();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const usd = (n: number) => displayFormat.usd(n);

  // No budget set → live spend only, clearly labelled as metered.
  if (budgetUsd == null || budgetUsd <= 0) {
    return (
      <div style={{ marginBottom: 4 }}>
        <div className="bv-mono" style={{ fontSize: 18, color: "var(--color-on-surface)" }}>
          {usd(costUsd)}
        </div>
        <div style={{ fontSize: 11, color: "var(--color-outline)", marginTop: 4 }}>
          {t("app.cost.liveNote")}
        </div>
      </div>
    );
  }

  const ratio = costUsd / budgetUsd;
  const pct = Math.min(ratio * 100, 100);
  // FORGE: arc under budget · ember nearing (≥75%) · molten over (≥100%).
  const fill =
    ratio >= 1
      ? "linear-gradient(90deg, #FF7A1A, #FF4D4D)"
      : ratio >= 0.75
      ? "linear-gradient(90deg, #3B82F6, #FF7A1A)"
      : "linear-gradient(90deg, #3B82F6, #2563EB)";
  const statusLabel =
    ratio >= 1 ? t("app.cost.statusOver") : ratio >= 0.75 ? t("app.cost.statusNear") : t("app.cost.statusUnder");
  const statusColor = ratio >= 1 ? "#FF4D4D" : ratio >= 0.75 ? "#FF7A1A" : "#60A5FA";

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          height: 10,
          borderRadius: 6,
          background: "var(--color-surface-container-low)",
          border: "1px solid var(--bv-glass-border)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: fill,
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
        <span style={{ color: statusColor }}>{usd(costUsd)}</span>
        <span>{t("app.cost.budgetLabel", { amount: usd(budgetUsd) })}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 10.5, color: statusColor }}>{statusLabel}</span>
        <span style={{ fontSize: 10.5, color: "var(--color-outline)" }}>{t("app.cost.liveNote")}</span>
      </div>
    </div>
  );
}

/* ── Cross-model handoff panel (E3/T8) ────────────────────────────────────
 * Two affordances, chosen from the ledger:
 *  • No OPEN ledger  → "Hand off this task" button (POST /runs/:id/handoff).
 *    On a RUNNING run this freezes the checkpoint at the next turn boundary;
 *    on a non-running run it copies the frozen transcript immediately.
 *  • OPEN ledger      → takeover-provider picker + "Continue with X"
 *    (POST /runs/:id/continue). While the live loop hasn't frozen the
 *    checkpoint yet the API answers 409 CHECKPOINT_PENDING — we surface a
 *    calm "freezing…" note and let the operator retry.
 * A flat timeline of every ledger row sits below, tolerant of the
 * stepIndex-per-multiple-rows reality (B6.5) — it's a plain list. FORGE
 * palette throughout: OPEN/CLAIMED = arc-blue, COMPLETED = arc-blue,
 * FAILED = molten red, CANCELLED = steel. No green anywhere. */

type ProviderLink = {
  provider: string;
  model: string;
  isDefault: boolean;
  fallbackOrder: number | null;
  baseUrl: string | null;
  keyMasked: string | null;
};

type HandoffRow = {
  id: string;
  runId: string;
  stepIndex: number;
  status: "OPEN" | "CLAIMED" | "COMPLETED" | "FAILED" | "CANCELLED";
  reason: "MANUAL" | "PROVIDER_FAILOVER" | "PROVIDER_EXHAUSTED" | "SESSION_LOST";
  fromProvider: string;
  fromModel: string;
  toProvider: string | null;
  toModel: string | null;
  contextSummary: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
};

// Keyless-local providers (user-supplied baseUrl, no API key). These appear in
// the picker even without a configured link so the operator can hand off to a
// local model on the fly.
const LOCAL_PROVIDERS = ["OLLAMA", "LMSTUDIO", "CUSTOM"] as const;
const isLocalProvider = (p: string) => (LOCAL_PROVIDERS as readonly string[]).includes(p.toUpperCase());

function HandoffPanel({
  runId,
  runStatus,
  token,
  t,
}: {
  runId: string;
  runStatus: string;
  token: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const relativeLocale = useRelativeLocale();
  const describeFailure = useLocalizedFailure();
  const [ledgers, setLedgers] = useState<HandoffRow[]>([]);
  const [links, setLinks] = useState<ProviderLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const load = async () => {
    try {
      const [h, p] = await Promise.all([
        api.listHandoffs(token, runId),
        api.listProviderLinks(token).catch(() => ({ providers: [] as ProviderLink[] })),
      ]);
      setLedgers(h.handoffs ?? []);
      setLinks(p.providers ?? []);
    } catch {
      /* leave prior state — the run page's own error banner covers hard failures */
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, token, runStatus]);

  const openLedger = ledgers.find((l) => l.status === "OPEN") ?? null;

  // Local models default to localhost only outside production; in prod the
  // API rejects a keyless-local claim without an explicit baseUrl (B4c), so we
  // require the field there. We can't read NODE_ENV client-side reliably, so
  // we always show the field for local providers and only hard-block empty
  // when it's clearly a hosted origin (non-localhost). The API is the real
  // gate — this is guidance, not enforcement.
  const localSelected = isLocalProvider(provider);

  // Build the picker options: configured cloud/local links first (labelled with
  // their masked key), then any local providers not already configured.
  const linkProviders = new Set(links.map((l) => l.provider.toUpperCase()));
  const extraLocals = LOCAL_PROVIDERS.filter((p) => !linkProviders.has(p));

  const doHandoff = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.startHandoff(token, runId);
      setNotice({
        kind: "info",
        text: res.checkpointPending ? t("app.handoff.freezingNote") : t("app.handoff.frozenNote"),
      });
      await load();
    } catch (e) {
      setNotice({ kind: "error", text: describeFailure(e, t("app.handoff.errorGeneric")) });
    } finally {
      setBusy(false);
    }
  };

  const doContinue = async () => {
    if (busy || !provider) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.continueHandoff(token, runId, {
        provider,
        baseUrl: localSelected && baseUrl.trim() ? baseUrl.trim() : undefined,
      });
      setNotice({ kind: "info", text: t("app.handoff.continuedNote", { provider }) });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("app.handoff.errorGeneric");
      // The API answers 409 CHECKPOINT_PENDING while the live loop hasn't
      // reached a turn boundary. Present it as a transient "freezing" state,
      // not a hard error, and invite a retry.
      const pending = /checkpoint_pending|freezing|turn boundary/i.test(msg);
      setNotice({
        kind: pending ? "info" : "error",
        text: pending ? t("app.handoff.pendingRetry") : describeFailure(e, t("app.handoff.errorGeneric")),
      });
    } finally {
      setBusy(false);
    }
  };

  const reasonLabel = (r: HandoffRow["reason"]) =>
    r === "MANUAL" ? t("app.handoff.reasonManual") :
    r === "PROVIDER_FAILOVER" ? t("app.handoff.reasonFailover") :
    r === "PROVIDER_EXHAUSTED" ? t("app.handoff.reasonExhausted") :
    t("app.handoff.reasonSessionLost");

  if (!loaded) {
    return <div className="animate-shimmer" style={{ height: 84, borderRadius: 16 }} />;
  }

  // Nothing to show only when there's neither history nor an actionable state.
  const canRequest = !openLedger;

  return (
    <section className="bv-glass bv-panel">
      <header className="bv-panel-head">
        <div>
          <h2 className="bv-title">{t("app.handoff.title")}</h2>
          <div className="bv-caption">{t("app.handoff.subtitle")}</div>
        </div>
      </header>

      {/* ── Action zone ── */}
      {openLedger ? (
        /* Continue: pick a takeover provider */
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 14,
            background: "linear-gradient(135deg,rgba(59,130,246,0.06),transparent)",
            border: "1px solid rgba(59,130,246,0.3)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="bv-dot bv-completed" aria-hidden />
            <span style={{ fontSize: 13, color: "var(--color-on-surface)" }}>
              {t("app.handoff.openBanner", { from: openLedger.fromProvider })}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label
              className="bv-mono"
              style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-outline)" }}
            >
              {t("app.handoff.pickProvider")}
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="bv-mono"
              style={{
                width: "100%",
                padding: "9px 12px",
                borderRadius: 10,
                background: "var(--color-surface-container-low)",
                border: "1px solid var(--bv-glass-border)",
                color: "var(--color-on-surface)",
                fontSize: 13,
                outline: "none",
              }}
            >
              <option value="">{t("app.handoff.pickPlaceholder")}</option>
              {links.map((l) => (
                <option key={`link-${l.provider}`} value={l.provider}>
                  {l.provider} · {l.model}
                  {l.keyMasked ? ` (${l.keyMasked})` : l.baseUrl ? ` (${l.baseUrl})` : ""}
                  {l.isDefault ? ` · ${t("app.handoff.defaultTag")}` : ""}
                </option>
              ))}
              {extraLocals.map((p) => (
                <option key={`local-${p}`} value={p}>
                  {p} · {t("app.handoff.localTag")}
                </option>
              ))}
            </select>

            {localSelected && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label
                  className="bv-mono"
                  style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-outline)" }}
                >
                  {t("app.handoff.baseUrlLabel")}
                </label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://models.example.com/v1"
                  className="bv-mono"
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: 10,
                    background: "var(--color-surface-container-low)",
                    border: "1px solid var(--bv-glass-border)",
                    color: "var(--color-on-surface)",
                    fontSize: 13,
                    outline: "none",
                  }}
                />
                <span style={{ fontSize: 10.5, color: "var(--color-outline)" }}>
                  {t("app.handoff.baseUrlHint")}
                </span>
              </div>
            )}
          </div>

          <button
            className="bv-btn bv-btn-primary"
            onClick={() => void doContinue()}
            disabled={busy || !provider}
            style={{ alignSelf: "flex-start" }}
          >
            {busy ? (
              <span
                className="inline-block border-2 border-t-transparent rounded-full animate-spin"
                style={{ width: 13, height: 13, borderColor: "rgba(255,255,255,0.5)", borderTopColor: "transparent" }}
              />
            ) : (
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>swap_horiz</span>
            )}
            {provider
              ? t("app.handoff.continueWith", { provider })
              : t("app.handoff.continueButton")}
          </button>
        </div>
      ) : canRequest ? (
        /* Request a handoff */
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--color-on-surface-variant)", lineHeight: 1.5 }}>
            {t("app.handoff.requestBlurb")}
          </p>
          <button
            className="bv-btn bv-btn-ghost bv-btn-sm"
            onClick={() => void doHandoff()}
            disabled={busy}
            style={{ alignSelf: "flex-start" }}
          >
            {busy ? (
              <span
                className="inline-block border-2 border-t-transparent rounded-full animate-spin"
                style={{ width: 13, height: 13, borderColor: "rgba(96,165,250,0.4)", borderTopColor: "transparent" }}
              />
            ) : (
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>alt_route</span>
            )}
            {t("app.handoff.requestButton")}
          </button>
        </div>
      ) : null}

      {/* ── Notice ── */}
      {notice && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: 10,
            fontSize: 12.5,
            lineHeight: 1.5,
            background: notice.kind === "error" ? "rgba(255,77,77,0.06)" : "rgba(59,130,246,0.06)",
            border: `1px solid ${notice.kind === "error" ? "rgba(255,77,77,0.25)" : "rgba(59,130,246,0.22)"}`,
            color: notice.kind === "error" ? "#FF4D4D" : "var(--color-on-surface)",
          }}
        >
          {notice.text}
        </div>
      )}

      {/* ── Ledger timeline ── */}
      {ledgers.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="bv-micro" style={{ marginBottom: 10 }}>{t("app.handoff.historyTitle")}</div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {ledgers.map((l) => (
              <li
                key={l.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid var(--bv-glass-border)",
                  fontSize: 12.5,
                  flexWrap: "wrap",
                }}
              >
                <HandoffStatusBadge status={l.status} t={t} />
                <span className="bv-mono" style={{ color: "var(--color-on-surface)" }}>
                  {l.fromProvider}
                  <span style={{ color: "var(--color-outline)", margin: "0 6px" }}>→</span>
                  {l.toProvider ?? t("app.handoff.awaiting")}
                </span>
                <span className="bv-pill bv-pill-muted">{reasonLabel(l.reason)}</span>
                <span style={{ marginInlineStart: "auto", fontSize: 11, color: "var(--color-outline)" }}>
                  {timeAgo(l.createdAt, relativeLocale)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* Handoff status badge — arc-blue for OPEN/CLAIMED/COMPLETED, molten for
 * FAILED, steel for CANCELLED. No green. */
function HandoffStatusBadge({
  status,
  t,
}: {
  status: HandoffRow["status"];
  t: ReturnType<typeof useTranslations>;
}) {
  const label =
    status === "OPEN" ? t("app.handoff.statusOpen") :
    status === "CLAIMED" ? t("app.handoff.statusClaimed") :
    status === "COMPLETED" ? t("app.handoff.statusCompleted") :
    status === "FAILED" ? t("app.handoff.statusFailed") :
    t("app.handoff.statusCancelled");

  const dotCls =
    status === "FAILED" ? "bv-failed" :
    status === "CANCELLED" ? "bv-paused" :
    "bv-completed"; // OPEN / CLAIMED / COMPLETED all read as arc-blue

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`bv-dot ${dotCls}`} aria-hidden />
      <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
}

/* ── Docked steer composer (shown when run is live) ── */
function SteerDock({ runId, token }: { runId: string; token: string }) {
  const uiText = useLegacyTranslations("uiCopy");
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
        >{uiText("m2c81a45dc959")}</span>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          placeholder={uiText("m6ef14dc92d42")}
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
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>send</span>{uiText("m597ddeea5d27")}</button>
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
