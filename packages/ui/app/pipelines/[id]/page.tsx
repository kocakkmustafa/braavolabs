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
import { PipelineGraph } from "../../../components/PipelineGraph";

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

  useEffect(() => {
    if (!token || !pipelineId) return;
    setLoaded(false);
    api
      .getPipeline(token, pipelineId)
      .then(setPipeline)
      .catch((e) => setErr(e instanceof Error ? e.message : t("app.pipelineDetail.loadFailed")))
      .finally(() => setLoaded(true));
  }, [token, pipelineId]);

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
          style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }}
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
    <div className="bv-dash bv-dash-shell">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div style={{ marginBottom: 16 }}>
          <Link href="/pipelines" style={{ color: "var(--color-primary, #a4e6ff)", fontSize: 13, textDecoration: "none" }}>
            ← {t("app.pipelineDetail.backLink")}
          </Link>
        </div>

        {!loaded ? (
          <div className="animate-shimmer" style={{ height: 96, borderRadius: 16 }} />
        ) : err ? (
          <div className="bv-glass bv-panel">
            <p style={{ color: "var(--color-error, #f87171)" }}>{err}</p>
          </div>
        ) : !pipeline ? (
          <div className="bv-glass bv-panel">
            <p>{t("app.pipelineDetail.notFound")}</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="bv-page-head bv-rise" style={{ marginBottom: 24 }}>
              <div style={{ minWidth: 0 }}>
                <div className="bv-micro" style={{ marginBottom: 6 }}>{t("app.pipelineDetail.pipelineLabel")}</div>
                <h1 className="bv-display" style={{ margin: 0, fontSize: 26 }}>
                  <span className="bv-grad-text">{pipeline.name}</span>
                </h1>
                <div className="bv-caption" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="bv-mono">{pipeline.id}</span>
                  <span className="bv-divider-dot" aria-hidden />
                  <span style={{ color: pipeline.enabled === false ? "#fbbf24" : "#34d399" }}>
                    {pipeline.enabled === false ? t("app.pipelineDetail.disabled") : t("app.pipelineDetail.enabled")}
                  </span>
                  {pipeline.company?.name && (
                    <>
                      <span className="bv-divider-dot" aria-hidden />
                      {pipeline.company.id ? (
                        <Link href={`/companies/${pipeline.company.id}`} style={{ color: "var(--color-on-surface-variant)", textDecoration: "none" }}>
                          {pipeline.company.name}
                        </Link>
                      ) : (
                        <span>{pipeline.company.name}</span>
                      )}
                    </>
                  )}
                  <span className="bv-divider-dot" aria-hidden />
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{TRIGGER_ICON[trigger] ?? "touch_app"}</span>
                    {trigger === "SCHEDULED" && pipeline.schedule ? pipeline.schedule : triggerWord}
                  </span>
                  <span className="bv-divider-dot" aria-hidden />
                  <span className="bv-pill bv-pill-muted">{isHierarchical ? t("app.pipelineDetail.typeHierarchical") : t("app.pipelineDetail.typeSequential")}</span>
                </div>
                {pipeline.description && (
                  <p className="bv-caption" style={{ marginTop: 10, maxWidth: 720 }}>{pipeline.description}</p>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "flex-start" }}>
                <button
                  onClick={startEditSettings}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#bbc9cf" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
                  {t("app.pipelineDetail.edit")}
                </button>
                <button
                  onClick={handleRun}
                  disabled={running}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}
                >
                  {running ? (
                    <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>play_arrow</span>
                  )}
                  {t("app.pipelineDetail.runNow")}
                </button>
              </div>
            </div>

            {editing && (
              <div className="bv-glass bv-panel" style={{ marginBottom: 16 }}>
                <h2 className="bv-title" style={{ marginBottom: 12 }}>{t("app.pipelineDetail.settingsTitle")}</h2>
                <label className="bv-caption" style={{ display: "block", marginBottom: 4 }}>{t("app.pipelineDetail.nameLabel")}</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={{ width: "100%", marginBottom: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "8px 12px", color: "#e1e2eb", fontSize: 14, outline: "none" }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13, color: "var(--color-on-surface-variant)" }}>
                  <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} />
                  {t("app.pipelineDetail.enabledToggle")}
                </label>
                {trigger === "SCHEDULED" && (
                  <>
                    <label className="bv-caption" style={{ display: "block", marginBottom: 4 }}>{t("app.pipelineDetail.scheduleLabel")}</label>
                    <input
                      value={editSchedule}
                      onChange={(e) => setEditSchedule(e.target.value)}
                      placeholder="0 9 * * *"
                      className="bv-mono"
                      style={{ width: "100%", marginBottom: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "8px 12px", color: "#e1e2eb", fontSize: 13, outline: "none" }}
                    />
                  </>
                )}
                {settingsErr && <p style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{settingsErr}</p>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button onClick={() => setEditing(false)} disabled={savingSettings} className="px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>{t("app.pipelines.nlCancel")}</button>
                  <button onClick={handleSaveSettings} disabled={savingSettings || !editName.trim()} className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}>{savingSettings ? t("app.pipelineDetail.saving") : t("app.pipelineDetail.save")}</button>
                </div>
              </div>
            )}

            {runErr && (
              <div className="bv-glass bv-panel" style={{ marginBottom: 16, borderColor: "rgba(248,113,113,0.25)" }}>
                <p style={{ margin: 0, color: "#f87171", fontSize: 13 }}>{runErr}</p>
              </div>
            )}

            {/* Steps / topology */}
            <section className="bv-glass bv-panel">
              <header className="bv-panel-head">
                <div>
                  <h2 className="bv-title">{t("app.pipelineDetail.stepsTitle")}</h2>
                  <div className="bv-caption">
                    {isHierarchical
                      ? t("app.pipelineDetail.managerDelegated")
                      : t("app.pipelineDetail.stageStepCount", { stages: stages.length, steps: pipeline.steps?.length ?? 0 })}
                  </div>
                </div>
                {!editingSteps && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {/* List / Graph view toggle */}
                    <div style={{ display: "inline-flex", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)" }}>
                      {(["list", "graph"] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => setStepView(v)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold"
                          style={{
                            background: stepView === v ? "rgba(0,209,255,0.12)" : "transparent",
                            color: stepView === v ? "#a4e6ff" : "#859399",
                            border: "none", cursor: "pointer",
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{v === "list" ? "format_list_bulleted" : "account_tree"}</span>
                          {v === "list" ? t("app.pipelineDetail.viewList") : t("app.pipelineDetail.viewGraph")}
                        </button>
                      ))}
                    </div>
                    {!isHierarchical && (
                      <button onClick={startEditSteps} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.2)", color: "#a4e6ff" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                        {t("app.pipelineDetail.editSteps")}
                      </button>
                    )}
                  </div>
                )}
              </header>

              {editingSteps ? (
                <div style={{ padding: 14 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {stepDraft.map((s, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, border: "1px solid var(--bv-glass-border)", borderRadius: 10, background: "rgba(255,255,255,0.02)", marginLeft: i > 0 && s.parallel ? 20 : 0 }}>
                        <span className="bv-pill bv-pill-muted">{t("app.pipelineDetail.stagePill", { n: stageIndexFor(stepDraft, i) + 1 })}</span>
                        <button
                          onClick={() => toggleParallel(i)}
                          disabled={i === 0}
                          title={t("app.pipelineDetail.parallelToggleTitle")}
                          style={{
                            background: s.parallel ? "rgba(0,209,255,0.12)" : "transparent",
                            border: s.parallel ? "1px solid rgba(0,209,255,0.3)" : "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 8, color: s.parallel ? "#a4e6ff" : "#859399",
                            cursor: i === 0 ? "default" : "pointer", padding: "4px 6px",
                            opacity: i === 0 ? 0.25 : 1, flexShrink: 0,
                          }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>call_split</span>
                        </button>
                        <input value={s.name} onChange={(e) => setStepField(i, "name", e.target.value)} placeholder={t("app.pipelineDetail.stepNamePlaceholder")} style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "6px 10px", color: "#e1e2eb", fontSize: 13, outline: "none" }} />
                        <select value={s.agentRole} onChange={(e) => setStepField(i, "agentRole", e.target.value)} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "6px 10px", color: "#e1e2eb", fontSize: 13, outline: "none" }}>
                          {s.agentRole && !agents.some((a) => a.role === s.agentRole || a.name === s.agentRole) && (
                            <option value={s.agentRole}>{s.agentRole}</option>
                          )}
                          {agents.length === 0 && !s.agentRole && <option value="">{t("app.pipelineDetail.noAgentsOption")}</option>}
                          {agents.map((a) => <option key={a.id} value={a.role}>{a.name}</option>)}
                        </select>
                        <button onClick={() => moveStep(i, -1)} disabled={i === 0} title={t("app.pipelineDetail.moveUp")} style={{ background: "transparent", border: "none", color: "#859399", cursor: "pointer", padding: 2, opacity: i === 0 ? 0.3 : 1 }}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_upward</span></button>
                        <button onClick={() => moveStep(i, 1)} disabled={i === stepDraft.length - 1} title={t("app.pipelineDetail.moveDown")} style={{ background: "transparent", border: "none", color: "#859399", cursor: "pointer", padding: 2, opacity: i === stepDraft.length - 1 ? 0.3 : 1 }}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_downward</span></button>
                        <button onClick={() => removeStep(i)} title={t("app.pipelineDetail.remove")} style={{ background: "transparent", border: "none", color: "#f87171", cursor: "pointer", padding: 2 }}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span></button>
                      </div>
                    ))}
                  </div>
                  <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#859399", marginTop: 10 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#a4e6ff" }}>call_split</span>
                    {t("app.pipelineDetail.parallelHint")}
                  </p>
                  <button onClick={addStep} className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span> {t("app.pipelineDetail.addStep")}
                  </button>
                  {agents.length === 0 && <p style={{ color: "#fbbf24", fontSize: 12, marginTop: 8 }}>{t("app.pipelineDetail.noAgentsWarning")}</p>}
                  {stepsErr && <p style={{ color: "#f87171", fontSize: 12, marginTop: 8 }}>{stepsErr}</p>}
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                    <button onClick={() => setEditingSteps(false)} disabled={savingSteps} className="px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>{t("app.pipelines.nlCancel")}</button>
                    <button onClick={saveSteps} disabled={savingSteps || stepDraft.length === 0} className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}>{savingSteps ? t("app.pipelineDetail.saving") : t("app.pipelineDetail.saveSteps")}</button>
                  </div>
                </div>
              ) : stepView === "graph" ? (
                <PipelineGraph stages={stages} isHierarchical={isHierarchical} maxDelegationDepth={pipeline.maxDelegationDepth} />
              ) : isHierarchical ? (
                <div style={{ padding: 16, fontSize: 13, color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}>
                  {t.rich("app.pipelineDetail.hierarchicalNote", {
                    depth: pipeline.maxDelegationDepth ?? 3,
                    b: (chunks) => <strong>{chunks}</strong>,
                  })}
                </div>
              ) : stages.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
                  {t("app.pipelineDetail.noSteps")}
                </div>
              ) : (
                <ol className="bv-stagger" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {stages.map((stage, idx) => {
                    const parallel = stage.steps.length > 1;
                    return (
                      <li
                        key={stage.order}
                        style={{
                          padding: 14,
                          border: "1px solid var(--bv-glass-border)",
                          borderRadius: 12,
                          background: "rgba(255,255,255,0.02)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: parallel ? 10 : 0 }}>
                          <span className="bv-pill bv-pill-muted">{t("app.pipelineDetail.stagePill", { n: idx + 1 })}</span>
                          {parallel && (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#a4e6ff" }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>call_split</span>
                              {t("app.pipelineDetail.parallelCount", { n: stage.steps.length })}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {stage.steps.map((s, j) => (
                            <div key={`${stage.order}-${j}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span
                                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                                style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.15)" }}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 15, color: "#00d1ff" }}>smart_toy</span>
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, color: "var(--color-on-surface)", fontSize: 14 }}>{s.name}</div>
                                <div className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)" }}>{s.agentRole}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {/* Recent runs */}
            <section className="bv-glass bv-panel" style={{ marginTop: 16 }}>
              <header className="bv-panel-head">
                <div>
                  <h2 className="bv-title">{t("app.pipelineDetail.recentRuns")}</h2>
                  <div className="bv-caption">{t("app.pipelineDetail.runsShown", { n: pipeline.runs?.length ?? 0 })}</div>
                </div>
              </header>

              {(!pipeline.runs || pipeline.runs.length === 0) ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
                  {t("app.pipelineDetail.noRuns")}
                </div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {pipeline.runs.map((r) => {
                    const cost = typeof r.costUsd === "number" ? r.costUsd : r.costUsd != null ? Number(r.costUsd) : null;
                    return (
                      <li key={r.id}>
                        <Link
                          href={`/runs/${r.id}`}
                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid var(--bv-glass-border)", textDecoration: "none" }}
                        >
                          <PipelineRunStatus status={(r.status ?? "pending").toLowerCase()} />
                          <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-on-surface-variant)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.id}
                          </span>
                          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                            {cost != null && <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>${cost.toFixed(2)}</span>}
                            <span className="bv-caption" style={{ fontSize: 12 }}>{timeAgo(r.createdAt ?? r.startedAt ?? "")}</span>
                            <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-outline)" }}>chevron_right</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function PipelineRunStatus({ status }: { status: string }) {
  const t = useTranslations();
  const label =
    status === "running" ? t("app.runAudit.statusRunning") :
    status === "completed" ? t("app.runAudit.statusCompleted") :
    status === "paused" ? t("app.runAudit.statusPaused") :
    status === "failed" ? t("app.runAudit.statusFailed") :
    status === "cancelled" ? t("app.runAudit.statusCancelled") :
    status === "waiting_approval" ? t("app.runAudit.statusWaiting") :
    t("app.runAudit.statusPending");
  const cls = status === "waiting_approval" || status === "pending" ? "bv-pending" : status;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`bv-dot bv-${cls} ${status === "running" ? "bv-ping" : ""}`} aria-hidden />
      <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
}
