"use client";

/**
 * /pipelines/[id] — single pipeline detail.
 *
 * Previously MISSING: the automation-importer success state and several
 * dashboard rows linked here and 404'd. This page gives a pipeline a home:
 * its step topology (sequential + same-`order` parallel groups, or the
 * hierarchical manager note), trigger/schedule, recent runs (→ /runs/[id]),
 * and a one-click "Run now". Read-only for now — a visual node editor lands
 * in a later phase; inline step editing builds on the existing
 * PATCH /pipelines/:id endpoint.
 *
 * Mirrors the `bv-*` design-system conventions used by /runs/[id].
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import { timeAgo } from "../../../lib/timeAgo";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";

// React Flow measures the DOM, so load the canvas client-only — never during
// SSR/prerender. Light shimmer while the chunk loads.
const PipelineCanvas = dynamic(
  () => import("../../../components/PipelineCanvas").then((m) => m.PipelineCanvas),
  {
    ssr: false,
    loading: () => (
      <div
        className="animate-shimmer"
        style={{ height: 420, borderRadius: 12, background: "rgba(255,255,255,0.04)" }}
      />
    ),
  },
);

interface PipelineStep {
  name: string;
  agentRole: string;
  order: number;
  config?: Record<string, unknown>;
  parallel?: boolean;
}

interface PipelineRun {
  id: string;
  status: string;
  trigger?: string;
  costUsd?: number | string | null;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
}

interface PipelineDetail {
  id: string;
  name: string;
  description?: string | null;
  trigger?: string;
  schedule?: string | null;
  enabled?: boolean;
  pipelineType?: "SEQUENTIAL" | "HIERARCHICAL";
  managerAgentId?: string | null;
  maxDelegationDepth?: number;
  steps?: PipelineStep[];
  company?: { id?: string; name?: string };
  runs?: PipelineRun[];
}

const TRIGGER_ICON: Record<string, string> = {
  MANUAL: "touch_app",
  SCHEDULED: "schedule",
  WEBHOOK: "webhook",
  EVENT: "bolt",
};

const STEP_TYPE_COLORS: Record<string, string> = {
  trigger: "#FF7A1A",
  agent:   "#3B82F6",
  tool:    "#7DD3FC",
  gate:    "#FF7A1A",
  branch:  "#9AA3B2",
  output:  "#60A5FA",
};

export default function PipelineDetailPage() {
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const pipelineId = params?.id;

  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editSchedule, setEditSchedule] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);
  const [editingSteps, setEditingSteps] = useState(false);
  const [stepView, setStepView] = useState<"list" | "graph">("list");
  // `parallel` = this step runs in the SAME stage as the previous one (engine
  // groups steps by `order`; same order ⇒ concurrent). The first step's flag
  // is ignored. order is recomputed from these flags on save.
  const [stepDraft, setStepDraft] = useState<Array<{ name: string; agentRole: string; parallel: boolean }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [savingSteps, setSavingSteps] = useState(false);
  const [stepsErr, setStepsErr] = useState<string | null>(null);
  // Pre-run cost ESTIMATE (D3). Advisory only — labelled as an estimate; live
  // cost on the run page is the source of truth.
  const [estimate, setEstimate] = useState<{
    lowUsd: number; highUsd: number; model: string;
    isFree: boolean; unknownModel: boolean; configured: boolean;
  } | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);

  useEffect(() => {
    if (!token || !pipelineId) return;
    setLoaded(false);
    api
      .getPipeline(token, pipelineId)
      .then(setPipeline)
      .catch((e) => setErr(e instanceof Error ? e.message : t("app.pipelineDetail.loadFailed")))
      .finally(() => setLoaded(true));
  }, [token, pipelineId]);

  // Fetch the cost estimate once the pipeline (and thus its step count) is
  // known. Best-effort: a failure just hides the line, it never blocks Run.
  useEffect(() => {
    if (!token || !pipelineId || !pipeline) return;
    let cancelled = false;
    setEstimateFailed(false);
    api
      .pipelineCostEstimate(token, pipelineId)
      .then((e) => { if (!cancelled) setEstimate(e); })
      .catch(() => { if (!cancelled) setEstimateFailed(true); });
    return () => { cancelled = true; };
  }, [token, pipelineId, pipeline?.steps?.length, pipeline?.pipelineType]);

  async function handleRun() {
    if (!token || !pipelineId) return;
    setRunning(true);
    setRunErr(null);
    try {
      const run = await api.triggerRun(token, pipelineId);
      if (run?.id) router.push(`/runs/${run.id}`);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : t("app.pipelineDetail.runFailed"));
      setRunning(false);
    }
  }

  function startEditSettings() {
    if (!pipeline) return;
    setEditName(pipeline.name ?? "");
    setEditEnabled(pipeline.enabled !== false);
    setEditSchedule(pipeline.schedule ?? "");
    setSettingsErr(null);
    setEditing(true);
  }

  async function handleSaveSettings() {
    if (!token || !pipelineId || !editName.trim()) return;
    setSavingSettings(true);
    setSettingsErr(null);
    try {
      const patch: Record<string, unknown> = { name: editName.trim(), enabled: editEnabled };
      if ((pipeline?.trigger ?? "").toUpperCase() === "SCHEDULED") patch.schedule = editSchedule.trim();
      await api.updatePipeline(token, pipelineId, patch);
      const fresh = await api.getPipeline(token, pipelineId);
      setPipeline(fresh);
      setEditing(false);
    } catch (e) {
      setSettingsErr(e instanceof Error ? e.message : t("app.pipelineDetail.saveFailed"));
    } finally {
      setSavingSettings(false);
    }
  }

  async function startEditSteps() {
    if (!pipeline || !token) return;
    const sorted = [...(pipeline.steps ?? [])].sort((a, b) => a.order - b.order);
    const draft = sorted.map((s, i) => ({
      name: s.name,
      agentRole: s.agentRole,
      // A step is "parallel" when it shares the previous step's order (stage).
      parallel: i > 0 && s.order === sorted[i - 1].order,
    }));
    setStepDraft(draft);
    setStepsErr(null);
    setEditingSteps(true);
    const companyId = pipeline.company?.id;
    if (companyId) {
      try { setAgents(await api.listAgents(token, companyId)); } catch { setAgents([]); }
    }
  }
  function setStepField(i: number, field: "name" | "agentRole", val: string) {
    setStepDraft((d) => d.map((s, idx) => (idx === i ? { ...s, [field]: val } : s)));
  }
  function addStep() {
    setStepDraft((d) => [...d, { name: t("app.pipelineDetail.newStep"), agentRole: agents[0]?.role ?? "", parallel: false }]);
  }
  function removeStep(i: number) {
    setStepDraft((d) => d.filter((_, idx) => idx !== i));
  }
  /** Toggle whether step i shares the previous step's stage (runs in parallel). */
  function toggleParallel(i: number) {
    if (i === 0) return;
    setStepDraft((d) => d.map((s, idx) => (idx === i ? { ...s, parallel: !s.parallel } : s)));
  }
  /** Derive the 0-based stage index for each draft row from the parallel flags. */
  function stageIndexFor(draft: Array<{ parallel: boolean }>, i: number): number {
    let stage = 0;
    for (let k = 1; k <= i; k++) if (!draft[k].parallel) stage++;
    return stage;
  }
  function moveStep(i: number, dir: number) {
    setStepDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.length) return d;
      const copy = [...d];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  async function saveSteps() {
    if (!token || !pipelineId) return;
    setSavingSteps(true);
    setStepsErr(null);
    try {
      // order is the STAGE index: a step keeps the previous order when flagged
      // parallel, else advances to a new stage. This is what lets the editor
      // express the engine's same-order ⇒ concurrent semantics.
      const steps = stepDraft.map((s, i) => ({
        name: s.name.trim() || `Step ${i + 1}`,
        agentRole: s.agentRole.trim(),
        order: stageIndexFor(stepDraft, i),
      }));
      await api.updatePipeline(token, pipelineId, { steps });
      const fresh = await api.getPipeline(token, pipelineId);
      setPipeline(fresh);
      setEditingSteps(false);
    } catch (e) {
      setStepsErr(e instanceof Error ? e.message : t("app.pipelineDetail.saveStepsFailed"));
    } finally {
      setSavingSteps(false);
    }
  }

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

  // Group steps by `order` so the UI shows the real topology: each order
  // index is one stage; multiple steps at the same order run in parallel.
  const stages = (() => {
    const steps = pipeline?.steps ?? [];
    const byOrder = new Map<number, PipelineStep[]>();
    for (const s of steps) {
      const g = byOrder.get(s.order) ?? [];
      g.push(s);
      byOrder.set(s.order, g);
    }
    return Array.from(byOrder.keys())
      .sort((a, b) => a - b)
      .map((order) => ({ order, steps: byOrder.get(order)! }));
  })();

  const isHierarchical = pipeline?.pipelineType === "HIERARCHICAL";
  const trigger = (pipeline?.trigger ?? "MANUAL").toUpperCase();
  const TRIGGER_KEY: Record<string, string> = {
    MANUAL: "triggerManual", SCHEDULED: "triggerScheduled", WEBHOOK: "triggerWebhook", EVENT: "triggerEvent",
  };
  const triggerWord = t(`app.pipelineDetail.${TRIGGER_KEY[trigger] ?? "triggerManual"}`);

  return (
    /* Full-viewport FORGE builder shell — 4-col grid (rail | palette | canvas | inspector)
       collapses to 3-col at 1200 px (palette hides) and 1-col at 900 px (inspector hides). */
    <div
      className="bv-dash"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr)",
        minHeight: "100vh",
        background: "var(--color-background)",
        backgroundImage:
          "radial-gradient(ellipse 80% 60% at 10% 20%, rgba(59,130,246,0.07) 0%, transparent 50%), radial-gradient(ellipse 60% 80% at 90% 80%, rgba(37,99,235,0.05) 0%, transparent 50%)",
      }}
    >
      {/* ── Builder wrapper: full-bleed grid ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "228px 196px 1fr 264px",
          height: "100vh",
          position: "relative",
        }}
      >
        {/* ── Rail / Sidebar ── */}
        <nav
          style={{
            background: "rgba(11,13,18,0.82)",
            backdropFilter: "blur(20px)",
            borderRight: "1px solid var(--bv-glass-border)",
            display: "flex",
            flexDirection: "column",
            padding: "20px 14px",
            gap: 4,
            overflowY: "auto",
          }}
        >
          {/* Back breadcrumb */}
          <Link
            href="/pipelines"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--color-on-surface-variant)",
              fontSize: 12,
              textDecoration: "none",
              marginBottom: 16,
              padding: "6px 8px",
              borderRadius: 8,
              transition: "color 0.2s, background 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.color = "var(--color-primary)";
              (e.currentTarget as HTMLAnchorElement).style.background = "rgba(59,130,246,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.color = "var(--color-on-surface-variant)";
              (e.currentTarget as HTMLAnchorElement).style.background = "transparent";
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>arrow_back</span>
            {t("app.pipelineDetail.backLink")}
          </Link>

          {/* Nav items */}
          {[
            { href: "/dashboard", icon: "dashboard", label: "Dashboard" },
            { href: "/pipelines", icon: "account_tree", label: "Pipelines", active: true },
            { href: "/runs", icon: "play_circle", label: "Runs" },
            { href: "/agents", icon: "smart_toy", label: "Agents" },
            { href: "/companies", icon: "business", label: "Companies" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: item.active ? 600 : 400,
                textDecoration: "none",
                color: item.active ? "#60A5FA" : "var(--color-on-surface-variant)",
                background: item.active ? "rgba(59,130,246,0.10)" : "transparent",
                border: item.active ? "1px solid rgba(59,130,246,0.18)" : "1px solid transparent",
                transition: "all 0.18s",
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* ── Palette — step types to drag in ── */}
        <aside
          style={{
            background: "rgba(11,13,18,0.70)",
            backdropFilter: "blur(14px)",
            borderRight: "1px solid var(--bv-glass-border)",
            padding: "18px 14px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <p
            className="bv-micro"
            style={{ marginBottom: 14 }}
          >
            Step types · drag in
          </p>

          {[
            { type: "trigger", icon: "bolt",         label: "Trigger",       color: "#FF7A1A" },
            { type: "agent",   icon: "smart_toy",    label: "Agent",         color: "#3B82F6" },
            { type: "tool",    icon: "construction", label: "Tool call",     color: "#7DD3FC" },
            { type: "gate",    icon: "approval",     label: "Approval gate", color: "#FF7A1A" },
            { type: "branch",  icon: "call_split",   label: "Branch",        color: "#9AA3B2" },
            { type: "output",  icon: "output",       label: "Output",        color: "#60A5FA" },
          ].map((item) => (
            <div
              key={item.type}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "10px 12px",
                border: "1px solid var(--bv-glass-border)",
                borderRadius: 11,
                background: "rgba(15,18,25,0.50)",
                marginBottom: 8,
                cursor: "grab",
                fontSize: 13,
                color: "var(--color-on-surface)",
                transition: "border-color 0.2s, transform 0.2s",
                userSelect: "none",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(59,130,246,0.35)";
                (e.currentTarget as HTMLDivElement).style.transform = "translateX(2px)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "var(--bv-glass-border)";
                (e.currentTarget as HTMLDivElement).style.transform = "translateX(0)";
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  background: `linear-gradient(135deg,${item.color},rgba(0,0,0,0.2))`,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#fff" }}>{item.icon}</span>
              </span>
              {item.label}
            </div>
          ))}
        </aside>

        {/* ── Canvas column ── */}
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            background: "radial-gradient(circle at 20% 20%, rgba(59,130,246,0.05), transparent 40%), var(--color-background)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* dot-grid overlay */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "radial-gradient(rgba(58,65,80,0.4) 1px, transparent 1px)",
              backgroundSize: "26px 26px",
              pointerEvents: "none",
              zIndex: 0,
            }}
          />

          {/* ── Toolbar ── */}
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 16,
              right: 16,
              zIndex: 20,
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {/* Canvas / List segmented toggle */}
            <div
              style={{
                display: "inline-flex",
                background: "rgba(15,18,25,0.80)",
                backdropFilter: "blur(14px)",
                border: "1px solid var(--bv-glass-border)",
                borderRadius: 10,
                padding: 4,
              }}
            >
              {(["graph", "list"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setStepView(v)}
                  style={{
                    border: "none",
                    background: stepView === v ? "rgba(59,130,246,0.18)" : "transparent",
                    color: stepView === v ? "#fff" : "var(--color-outline)",
                    fontSize: 13,
                    padding: "7px 14px",
                    borderRadius: 7,
                    cursor: "pointer",
                    transition: "background 0.2s, color 0.2s",
                    fontFamily: "inherit",
                    fontWeight: stepView === v ? 600 : 400,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                    {v === "graph" ? "account_tree" : "format_list_bulleted"}
                  </span>
                  {v === "graph" ? t("app.pipelineDetail.viewGraph") : t("app.pipelineDetail.viewList")}
                </button>
              ))}
            </div>

            {/* Pipeline name */}
            {!loaded ? (
              <div className="animate-shimmer" style={{ width: 160, height: 20, borderRadius: 6 }} />
            ) : pipeline ? (
              <span
                style={{
                  fontFamily: "var(--bv-font-display)",
                  fontSize: 16,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.02em",
                  marginLeft: 6,
                  color: "var(--color-on-surface)",
                }}
              >
                {pipeline.name}
              </span>
            ) : null}

            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              {/* Schedule / cron note */}
              {pipeline?.trigger?.toUpperCase() === "SCHEDULED" && pipeline.schedule && (
                <span
                  className="bv-mono"
                  style={{
                    fontSize: 11,
                    color: "var(--color-on-surface-variant)",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    borderRadius: 7,
                    padding: "4px 8px",
                    marginRight: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>schedule</span>
                  {pipeline.schedule}
                </span>
              )}

              {/* Edit settings */}
              <button
                onClick={startEditSettings}
                className="bv-btn bv-btn-ghost bv-btn-sm"
                disabled={!pipeline}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                {t("app.pipelineDetail.edit")}
              </button>

              {/* Pre-run cost estimate (D3) — honest range, never exact */}
              <CostEstimateChip estimate={estimate} failed={estimateFailed} t={t} />

              {/* Run now */}
              <button
                onClick={handleRun}
                disabled={running || !pipeline}
                className="bv-btn bv-btn-primary bv-btn-sm"
              >
                {running ? (
                  <span
                    className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"
                    style={{ width: 14, height: 14, borderWidth: 2 }}
                  />
                ) : (
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>play_arrow</span>
                )}
                {t("app.pipelineDetail.runNow")}
              </button>
            </div>
          </div>

          {/* ── Main canvas / list area ── */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              overflowY: "auto",
              paddingTop: 68,
              paddingBottom: 72,
              paddingLeft: 16,
              paddingRight: 16,
              zIndex: 1,
            }}
          >
            {!loaded ? (
              <div className="animate-shimmer" style={{ height: 320, borderRadius: 16, marginTop: 20 }} />
            ) : err ? (
              <div
                className="bv-glass bv-panel"
                style={{ marginTop: 20, borderColor: "rgba(255,77,77,0.2)" }}
              >
                <p style={{ color: "var(--color-error)", margin: 0, fontSize: 13 }}>{err}</p>
              </div>
            ) : !pipeline ? (
              <div className="bv-glass bv-panel" style={{ marginTop: 20 }}>
                <p style={{ color: "var(--color-on-surface-variant)", margin: 0 }}>
                  {t("app.pipelineDetail.notFound")}
                </p>
              </div>
            ) : stepView === "graph" ? (
              <PipelineCanvas
                stages={stages}
                isHierarchical={isHierarchical}
                maxDelegationDepth={pipeline.maxDelegationDepth}
              />
            ) : editingSteps ? (
              /* ── Step editor (list view, inline) ── */
              <div
                className="bv-glass bv-panel bv-rise"
                style={{ marginTop: 20 }}
              >
                <header className="bv-panel-head">
                  <h2 className="bv-title">{t("app.pipelineDetail.stepsTitle")}</h2>
                </header>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {stepDraft.map((s, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: 10,
                        border: "1px solid var(--bv-glass-border)",
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.02)",
                        marginLeft: i > 0 && s.parallel ? 20 : 0,
                      }}
                    >
                      <span className="bv-pill bv-pill-muted">
                        {t("app.pipelineDetail.stagePill", { n: stageIndexFor(stepDraft, i) + 1 })}
                      </span>
                      <button
                        onClick={() => toggleParallel(i)}
                        disabled={i === 0}
                        title={t("app.pipelineDetail.parallelToggleTitle")}
                        style={{
                          background: s.parallel ? "rgba(59,130,246,0.12)" : "transparent",
                          border: s.parallel ? "1px solid rgba(59,130,246,0.3)" : "1px solid rgba(255,255,255,0.08)",
                          borderRadius: 8,
                          color: s.parallel ? "#60A5FA" : "var(--color-outline)",
                          cursor: i === 0 ? "default" : "pointer",
                          padding: "4px 6px",
                          opacity: i === 0 ? 0.25 : 1,
                          flexShrink: 0,
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>call_split</span>
                      </button>
                      <input
                        value={s.name}
                        onChange={(e) => setStepField(i, "name", e.target.value)}
                        placeholder={t("app.pipelineDetail.stepNamePlaceholder")}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          borderRadius: 8,
                          padding: "6px 10px",
                          color: "var(--color-on-surface)",
                          fontSize: 13,
                          outline: "none",
                        }}
                      />
                      <select
                        value={s.agentRole}
                        onChange={(e) => setStepField(i, "agentRole", e.target.value)}
                        style={{
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          borderRadius: 8,
                          padding: "6px 10px",
                          color: "var(--color-on-surface)",
                          fontSize: 13,
                          outline: "none",
                        }}
                      >
                        {s.agentRole && !agents.some((a) => a.role === s.agentRole || a.name === s.agentRole) && (
                          <option value={s.agentRole}>{s.agentRole}</option>
                        )}
                        {agents.length === 0 && !s.agentRole && (
                          <option value="">{t("app.pipelineDetail.noAgentsOption")}</option>
                        )}
                        {agents.map((a) => (
                          <option key={a.id} value={a.role}>{a.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => moveStep(i, -1)}
                        disabled={i === 0}
                        title={t("app.pipelineDetail.moveUp")}
                        style={{ background: "transparent", border: "none", color: "var(--color-outline)", cursor: "pointer", padding: 2, opacity: i === 0 ? 0.3 : 1 }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_upward</span>
                      </button>
                      <button
                        onClick={() => moveStep(i, 1)}
                        disabled={i === stepDraft.length - 1}
                        title={t("app.pipelineDetail.moveDown")}
                        style={{ background: "transparent", border: "none", color: "var(--color-outline)", cursor: "pointer", padding: 2, opacity: i === stepDraft.length - 1 ? 0.3 : 1 }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_downward</span>
                      </button>
                      <button
                        onClick={() => removeStep(i)}
                        title={t("app.pipelineDetail.remove")}
                        style={{ background: "transparent", border: "none", color: "var(--color-error)", cursor: "pointer", padding: 2 }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                      </button>
                    </div>
                  ))}
                </div>

                <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--color-outline)", margin: "4px 0" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#60A5FA" }}>call_split</span>
                  {t("app.pipelineDetail.parallelHint")}
                </p>
                <button
                  onClick={addStep}
                  className="bv-btn bv-btn-ghost bv-btn-sm"
                  style={{ alignSelf: "flex-start" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                  {t("app.pipelineDetail.addStep")}
                </button>
                {agents.length === 0 && (
                  <p style={{ color: "#FF7A1A", fontSize: 12, margin: 0 }}>{t("app.pipelineDetail.noAgentsWarning")}</p>
                )}
                {stepsErr && (
                  <p style={{ color: "var(--color-error)", fontSize: 12, margin: 0 }}>{stepsErr}</p>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
                  <button
                    onClick={() => setEditingSteps(false)}
                    disabled={savingSteps}
                    className="bv-btn bv-btn-ghost"
                  >
                    {t("app.pipelines.nlCancel")}
                  </button>
                  <button
                    onClick={saveSteps}
                    disabled={savingSteps || stepDraft.length === 0}
                    className="bv-btn bv-btn-primary"
                  >
                    {savingSteps ? t("app.pipelineDetail.saving") : t("app.pipelineDetail.saveSteps")}
                  </button>
                </div>
              </div>
            ) : isHierarchical ? (
              /* ── Hierarchical note ── */
              <div
                className="bv-glass bv-panel bv-rise"
                style={{ marginTop: 20 }}
              >
                <header className="bv-panel-head">
                  <div>
                    <h2 className="bv-title">{t("app.pipelineDetail.stepsTitle")}</h2>
                    <div className="bv-caption">{t("app.pipelineDetail.managerDelegated")}</div>
                  </div>
                  <span className="bv-pill bv-pill-purple">{t("app.pipelineDetail.typeHierarchical")}</span>
                </header>
                <div style={{ fontSize: 13, color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}>
                  {t.rich("app.pipelineDetail.hierarchicalNote", {
                    depth: pipeline.maxDelegationDepth ?? 3,
                    b: (chunks) => <strong>{chunks}</strong>,
                  })}
                </div>
              </div>
            ) : (
              /* ── Sequential stage list ── */
              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <div>
                    <span className="bv-micro">
                      {t("app.pipelineDetail.stageStepCount", {
                        stages: stages.length,
                        steps: pipeline.steps?.length ?? 0,
                      })}
                    </span>
                  </div>
                  {!isHierarchical && (
                    <button
                      onClick={startEditSteps}
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                      {t("app.pipelineDetail.editSteps")}
                    </button>
                  )}
                </div>

                {stages.length === 0 ? (
                  <div
                    className="bv-glass bv-panel"
                    style={{ textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}
                  >
                    {t("app.pipelineDetail.noSteps")}
                  </div>
                ) : (
                  <ol className="bv-stagger" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    {stages.map((stage, idx) => {
                      const parallel = stage.steps.length > 1;
                      return (
                        <li
                          key={stage.order}
                          style={{
                            padding: 14,
                            border: "1px solid var(--bv-glass-border)",
                            borderRadius: 14,
                            background: "rgba(15,18,25,0.55)",
                            backdropFilter: "blur(12px)",
                            position: "relative",
                          }}
                        >
                          {/* Accent line — arc blue */}
                          <div
                            aria-hidden
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 14,
                              right: 14,
                              height: 1,
                              background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.4), transparent)",
                              opacity: 0.6,
                            }}
                          />

                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: parallel ? 10 : 6 }}>
                            <span className="bv-pill bv-pill-muted">
                              {t("app.pipelineDetail.stagePill", { n: idx + 1 })}
                            </span>
                            {parallel && (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  fontSize: 11,
                                  color: "#60A5FA",
                                  background: "rgba(59,130,246,0.08)",
                                  border: "1px solid rgba(59,130,246,0.18)",
                                  borderRadius: 999,
                                  padding: "2px 8px",
                                }}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 13 }}>call_split</span>
                                {t("app.pipelineDetail.parallelCount", { n: stage.steps.length })}
                              </span>
                            )}
                          </div>

                          {/* Parallel lane dashed border */}
                          {parallel && (
                            <div
                              style={{
                                border: "1px dashed rgba(96,165,250,0.25)",
                                borderRadius: 10,
                                padding: "8px 10px",
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                              }}
                            >
                              {stage.steps.map((s, j) => (
                                <StepRow key={`${stage.order}-${j}`} step={s} />
                              ))}
                            </div>
                          )}

                          {!parallel && stage.steps.map((s, j) => (
                            <StepRow key={`${stage.order}-${j}`} step={s} />
                          ))}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            )}
          </div>

          {/* ── Zoom controls (bottom-left) ── */}
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 16,
              zIndex: 20,
              display: "flex",
              gap: 6,
            }}
          >
            {[
              { icon: "remove", label: "zoom out" },
              { icon: "fit_screen", label: "fit" },
              { icon: "add", label: "zoom in" },
            ].map((btn) => (
              <button
                key={btn.label}
                aria-label={btn.label}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: "rgba(15,18,25,0.80)",
                  backdropFilter: "blur(10px)",
                  border: "1px solid var(--bv-glass-border)",
                  color: "var(--color-on-surface)",
                  cursor: "pointer",
                  fontSize: 17,
                  transition: "border-color 0.2s, color 0.2s",
                  display: "grid",
                  placeItems: "center",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(59,130,246,0.4)";
                  (e.currentTarget as HTMLButtonElement).style.color = "#60A5FA";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--bv-glass-border)";
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--color-on-surface)";
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{btn.icon}</span>
              </button>
            ))}
          </div>

          {/* ── Minimap (bottom-right) ── */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              bottom: 16,
              right: 16,
              zIndex: 20,
              width: 160,
              height: 104,
              background: "rgba(11,13,18,0.80)",
              border: "1px solid var(--bv-glass-border)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            {/* Minimap node previews */}
            {stages.map((stage, idx) => (
              <div
                key={stage.order}
                style={{
                  position: "absolute",
                  left: `${8 + idx * 22}px`,
                  top: `${12 + (stage.steps.length > 1 ? 8 : 20)}px`,
                  width: 18,
                  height: 10,
                  borderRadius: 2,
                  background: "#3B82F6",
                  opacity: 0.7,
                }}
              />
            ))}
          </div>
        </div>

        {/* ── Inspector panel (right) ── */}
        <aside
          style={{
            background: "rgba(11,13,18,0.70)",
            backdropFilter: "blur(14px)",
            borderLeft: "1px solid var(--bv-glass-border)",
            padding: "20px 18px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <p className="bv-micro">Inspector</p>

          {/* Pipeline metadata card */}
          {!loaded ? (
            <div className="animate-shimmer" style={{ height: 120, borderRadius: 12 }} />
          ) : pipeline ? (
            <>
              {/* Header metadata */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="bv-micro">{t("app.pipelineDetail.pipelineLabel")}</span>
                  <h1
                    className="bv-grad-text"
                    style={{
                      fontFamily: "var(--bv-font-display)",
                      fontSize: 18,
                      fontWeight: 700,
                      margin: 0,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {pipeline.name}
                  </h1>
                </div>

                {pipeline.description && (
                  <p className="bv-caption" style={{ margin: 0, lineHeight: 1.5 }}>
                    {pipeline.description}
                  </p>
                )}

                {/* ID */}
                <span
                  className="bv-mono"
                  style={{
                    fontSize: 10,
                    color: "var(--color-outline)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "block",
                  }}
                >
                  {pipeline.id}
                </span>

                {/* Status + type pills */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <span className={`bv-pill ${pipeline.enabled === false ? "bv-pill-amber" : "bv-pill-cyan"}`}>
                    {pipeline.enabled === false ? t("app.pipelineDetail.disabled") : t("app.pipelineDetail.enabled")}
                  </span>
                  <span className="bv-pill bv-pill-muted">
                    {isHierarchical ? t("app.pipelineDetail.typeHierarchical") : t("app.pipelineDetail.typeSequential")}
                  </span>
                </div>

                {/* Trigger */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 12,
                    color: "var(--color-on-surface-variant)",
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                    {TRIGGER_ICON[trigger] ?? "touch_app"}
                  </span>
                  <span>{trigger === "SCHEDULED" && pipeline.schedule ? pipeline.schedule : triggerWord}</span>
                </div>

                {/* Company */}
                {pipeline.company?.name && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-on-surface-variant)" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>business</span>
                    {pipeline.company.id ? (
                      <Link
                        href={`/companies/${pipeline.company.id}`}
                        style={{ color: "var(--color-on-surface-variant)", textDecoration: "none" }}
                      >
                        {pipeline.company.name}
                      </Link>
                    ) : (
                      <span>{pipeline.company.name}</span>
                    )}
                  </div>
                )}
              </div>

              <div className="bv-divider" />

              {/* Settings edit form (inline in inspector) */}
              {editing ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <h2 className="bv-title">{t("app.pipelineDetail.settingsTitle")}</h2>

                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label className="bv-caption">{t("app.pipelineDetail.nameLabel")}</label>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{
                        width: "100%",
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 10,
                        padding: "8px 10px",
                        color: "var(--color-on-surface)",
                        fontSize: 13,
                        outline: "none",
                      }}
                    />
                  </div>

                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-on-surface-variant)" }}>
                    <input
                      type="checkbox"
                      checked={editEnabled}
                      onChange={(e) => setEditEnabled(e.target.checked)}
                    />
                    {t("app.pipelineDetail.enabledToggle")}
                  </label>

                  {trigger === "SCHEDULED" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label className="bv-caption">{t("app.pipelineDetail.scheduleLabel")}</label>
                      <input
                        value={editSchedule}
                        onChange={(e) => setEditSchedule(e.target.value)}
                        placeholder="0 9 * * *"
                        className="bv-mono"
                        style={{
                          width: "100%",
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          borderRadius: 10,
                          padding: "8px 10px",
                          color: "var(--color-on-surface)",
                          fontSize: 12,
                          outline: "none",
                        }}
                      />
                    </div>
                  )}

                  {settingsErr && (
                    <p style={{ color: "var(--color-error)", fontSize: 12, margin: 0 }}>{settingsErr}</p>
                  )}

                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => setEditing(false)}
                      disabled={savingSettings}
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                      style={{ flex: 1 }}
                    >
                      {t("app.pipelines.nlCancel")}
                    </button>
                    <button
                      onClick={handleSaveSettings}
                      disabled={savingSettings || !editName.trim()}
                      className="bv-btn bv-btn-primary bv-btn-sm"
                      style={{ flex: 1 }}
                    >
                      {savingSettings ? t("app.pipelineDetail.saving") : t("app.pipelineDetail.save")}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <p className="bv-micro">Step inspector</p>
                  <p style={{ fontSize: 13, color: "var(--color-outline)", margin: 0 }}>
                    Select a step in the canvas to configure it.
                  </p>
                </div>
              )}

              {/* Run error banner */}
              {runErr && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "rgba(255,77,77,0.08)",
                    border: "1px solid rgba(255,77,77,0.2)",
                  }}
                >
                  <p style={{ margin: 0, color: "var(--color-error)", fontSize: 12 }}>{runErr}</p>
                </div>
              )}

              <div className="bv-divider" />

              {/* Recent runs */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <p className="bv-micro">{t("app.pipelineDetail.recentRuns")}</p>
                  <span className="bv-caption">{t("app.pipelineDetail.runsShown", { n: pipeline.runs?.length ?? 0 })}</span>
                </div>

                {(!pipeline.runs || pipeline.runs.length === 0) ? (
                  <p style={{ fontSize: 12, color: "var(--color-outline)", margin: 0, textAlign: "center", padding: "12px 0" }}>
                    {t("app.pipelineDetail.noRuns")}
                  </p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {pipeline.runs.map((r) => {
                      const cost = typeof r.costUsd === "number" ? r.costUsd : r.costUsd != null ? Number(r.costUsd) : null;
                      return (
                        <li key={r.id}>
                          <Link
                            href={`/runs/${r.id}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "8px 10px",
                              borderRadius: 10,
                              background: "rgba(255,255,255,0.02)",
                              border: "1px solid var(--bv-glass-border)",
                              textDecoration: "none",
                              transition: "background 0.18s, border-color 0.18s",
                            }}
                            onMouseEnter={(e) => {
                              (e.currentTarget as HTMLAnchorElement).style.background = "rgba(59,130,246,0.04)";
                              (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(59,130,246,0.15)";
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.02)";
                              (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--bv-glass-border)";
                            }}
                          >
                            <PipelineRunStatus status={(r.status ?? "pending").toLowerCase()} />
                            <span
                              className="bv-mono"
                              style={{
                                fontSize: 10,
                                color: "var(--color-on-surface-variant)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                flex: 1,
                                minWidth: 0,
                              }}
                            >
                              {r.id}
                            </span>
                            <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                              {cost != null && (
                                <span className="bv-mono" style={{ fontSize: 10, color: "var(--color-outline)" }}>
                                  ${cost.toFixed(2)}
                                </span>
                              )}
                              <span className="bv-caption" style={{ fontSize: 10 }}>
                                {timeAgo(r.createdAt ?? r.startedAt ?? "")}
                              </span>
                              <span className="material-symbols-outlined" style={{ fontSize: 14, color: "var(--color-outline)" }}>
                                chevron_right
                              </span>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/** Single step row used in the sequential stage list. */
function StepRow({ step }: { step: PipelineStep }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          background: "rgba(59,130,246,0.10)",
          border: "1px solid rgba(59,130,246,0.18)",
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 15, color: "#60A5FA" }}>smart_toy</span>
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: "var(--color-on-surface)", fontSize: 13 }}>{step.name}</div>
        <div className="bv-mono" style={{ fontSize: 10, color: "var(--color-outline)" }}>{step.agentRole}</div>
      </div>
    </div>
  );
}

function PipelineRunStatus({ status }: { status: string }) {
  const t = useTranslations();
  const label =
    status === "running"           ? t("app.runAudit.statusRunning") :
    status === "completed"         ? t("app.runAudit.statusCompleted") :
    status === "paused"            ? t("app.runAudit.statusPaused") :
    status === "failed"            ? t("app.runAudit.statusFailed") :
    status === "cancelled"         ? t("app.runAudit.statusCancelled") :
    status === "waiting_approval"  ? t("app.runAudit.statusWaiting") :
    t("app.runAudit.statusPending");
  const cls = status === "waiting_approval" || status === "pending" ? "bv-pending" : status;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        className={`bv-dot bv-${cls} ${status === "running" ? "bv-ping" : ""}`}
        aria-hidden
      />
      <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
}

/** Format a USD estimate with precision that suits the magnitude — sub-cent
 *  numbers need more decimals to read as anything other than "$0.00". */
function fmtEstimateUsd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/* ── Pre-run cost estimate chip (D3) ──────────────────────────────────────
 * Differentiator: a per-run cost ESTIMATE before you press Run. Honest by
 * construction — always a range, always labelled an estimate, with an info
 * tooltip pointing at the live figure. Local providers read "Free". */
function CostEstimateChip({
  estimate,
  failed,
  t,
}: {
  estimate: {
    lowUsd: number; highUsd: number; model: string;
    isFree: boolean; unknownModel: boolean; configured: boolean;
  } | null;
  failed: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  // Nothing to show yet (loading) — stay quiet rather than flashing.
  if (!estimate && !failed) return null;

  let text: string;
  let tip = t("app.cost.estimateTooltip");
  let showBadge = true;

  if (failed) {
    text = t("app.cost.estimateFailed");
    showBadge = false;
  } else if (estimate!.isFree) {
    text = t("app.cost.estimateFree");
    showBadge = false;
  } else if (!estimate!.configured) {
    text = t("app.cost.estimateNotConfigured");
    showBadge = false;
  } else if (estimate!.unknownModel) {
    text = t("app.cost.estimateUnknown");
    showBadge = false;
  } else {
    text =
      t("app.cost.estimateLabel", {
        low: fmtEstimateUsd(estimate!.lowUsd),
        high: fmtEstimateUsd(estimate!.highUsd),
      }) + t("app.cost.estimateModelSuffix", { model: estimate!.model });
  }

  return (
    <span
      title={tip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        border: "1px solid rgba(59,130,246,0.25)",
        background: "rgba(59,130,246,0.07)",
        fontSize: 11.5,
        color: "var(--color-on-surface-variant)",
        whiteSpace: "nowrap",
        cursor: "help",
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#60A5FA" }}>
        payments
      </span>
      <span className="bv-mono">{text}</span>
      {showBadge && (
        <span
          className="bv-mono"
          style={{
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "#60A5FA",
            opacity: 0.8,
          }}
        >
          {t("app.cost.estimateBadge")}
        </span>
      )}
      <span className="material-symbols-outlined" style={{ fontSize: 13, color: "var(--color-outline)" }}>
        info
      </span>
    </span>
  );
}
