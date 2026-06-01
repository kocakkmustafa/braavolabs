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
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const pipelineId = params?.id;

  const [pipeline, setPipeline] = useState<PipelineDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !pipelineId) return;
    setLoaded(false);
    api
      .getPipeline(token, pipelineId)
      .then(setPipeline)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load pipeline"))
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
      setRunErr(e instanceof Error ? e.message : "Failed to start run");
      setRunning(false);
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

  return (
    <div className="bv-dash bv-dash-shell">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div style={{ marginBottom: 16 }}>
          <Link href="/pipelines" style={{ color: "var(--color-primary, #a4e6ff)", fontSize: 13, textDecoration: "none" }}>
            ← Pipelines
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
            <p>Pipeline not found.</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="bv-page-head bv-rise" style={{ marginBottom: 24 }}>
              <div style={{ minWidth: 0 }}>
                <div className="bv-micro" style={{ marginBottom: 6 }}>Pipeline</div>
                <h1 className="bv-display" style={{ margin: 0, fontSize: 26 }}>
                  <span className="bv-grad-text">{pipeline.name}</span>
                </h1>
                <div className="bv-caption" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="bv-mono">{pipeline.id}</span>
                  <span className="bv-divider-dot" aria-hidden />
                  <span style={{ color: pipeline.enabled === false ? "#fbbf24" : "#34d399" }}>
                    {pipeline.enabled === false ? "Disabled" : "Enabled"}
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
                    {trigger === "SCHEDULED" && pipeline.schedule ? pipeline.schedule : trigger.toLowerCase()}
                  </span>
                  <span className="bv-divider-dot" aria-hidden />
                  <span className="bv-pill bv-pill-muted">{isHierarchical ? "Hierarchical" : "Sequential"}</span>
                </div>
                {pipeline.description && (
                  <p className="bv-caption" style={{ marginTop: 10, maxWidth: 720 }}>{pipeline.description}</p>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "flex-start" }}>
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
                  Run now
                </button>
              </div>
            </div>

            {runErr && (
              <div className="bv-glass bv-panel" style={{ marginBottom: 16, borderColor: "rgba(248,113,113,0.25)" }}>
                <p style={{ margin: 0, color: "#f87171", fontSize: 13 }}>{runErr}</p>
              </div>
            )}

            {/* Steps / topology */}
            <section className="bv-glass bv-panel">
              <header className="bv-panel-head">
                <div>
                  <h2 className="bv-title">Steps</h2>
                  <div className="bv-caption">
                    {isHierarchical
                      ? "Manager-delegated — workers are chosen at runtime"
                      : `${stages.length} stage${stages.length === 1 ? "" : "s"} · ${pipeline.steps?.length ?? 0} step${(pipeline.steps?.length ?? 0) === 1 ? "" : "s"}`}
                  </div>
                </div>
              </header>

              {isHierarchical ? (
                <div style={{ padding: 16, fontSize: 13, color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}>
                  This pipeline uses a <strong>manager agent</strong> that plans and delegates tasks to worker
                  agents at runtime (max delegation depth {pipeline.maxDelegationDepth ?? 3}). There is no fixed
                  step list to display.
                </div>
              ) : stages.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
                  No steps defined yet.
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
                          <span className="bv-pill bv-pill-muted">stage {idx + 1}</span>
                          {parallel && (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#a4e6ff" }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>call_split</span>
                              {stage.steps.length} parallel
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
                  <h2 className="bv-title">Recent runs</h2>
                  <div className="bv-caption">{pipeline.runs?.length ?? 0} shown</div>
                </div>
              </header>

              {(!pipeline.runs || pipeline.runs.length === 0) ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
                  No runs yet. Hit “Run now” to start the first one.
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
