"use client";

/**
 * /runs — flat list of recent runs across the tenant.
 *
 * Surfaces the same listRuns endpoint the dashboard already pulls,
 * but unfiltered + paginated. Linked from /dashboard's "View all"
 * button on the Recent runs panel. Reuses the bv-* design system
 * landed alongside the dashboard refresh.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { timeAgo } from "../../lib/timeAgo";
import { useTranslations } from "next-intl";

type RunStatus =
  | "RUNNING" | "COMPLETED" | "PAUSED" | "FAILED" | "CANCELLED" | "PENDING" | "WAITING_APPROVAL";

interface RunRow {
  id: string;
  pipelineName?: string;
  pipeline?: { name?: string; companyName?: string };
  companyName?: string;
  status: RunStatus;
  startedAt?: string;
  createdAt?: string;
  stepsCompleted?: number;
  stepsTotal?: number;
  costUsd?: number;
}

const PAGE_SIZE = 25;

export default function RunsPage() {
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<"all" | "running" | "completed" | "pending" | "failed">("all");

  useEffect(() => {
    if (!token) return;
    setLoaded(false);
    api.listRuns(token, PAGE_SIZE, offset)
      .then((d) => { setRuns(d.runs ?? []); setTotal(d.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [token, offset]);

  const filtered = useMemo(() => {
    if (filter === "all") return runs;
    return runs.filter((r) => (r.status ?? "").toLowerCase() === filter);
  }, [runs, filter]);

  const counts = useMemo(() => ({
    all: runs.length,
    running: runs.filter((r) => (r.status ?? "").toLowerCase() === "running").length,
    completed: runs.filter((r) => (r.status ?? "").toLowerCase() === "completed").length,
    pending: runs.filter((r) => (r.status ?? "").toLowerCase() === "pending").length,
    failed: runs.filter((r) => (r.status ?? "").toLowerCase() === "failed").length,
  }), [runs]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
      </div>
    );
  }

  return (
    <div className="bv-dash bv-dash-shell">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="bv-page-head bv-rise" style={{ marginBottom: 24 }}>
          <div>
            <div className="bv-micro" style={{ marginBottom: 6 }}>{t("app.runsList.activity")}</div>
            <h1 className="bv-display" style={{ margin: 0 }}>{t("app.runsList.title")}</h1>
            <div className="bv-caption" style={{ marginTop: 8 }}>
              {total > 0 ? t("app.runsList.totalCount", { n: total }) : t("app.runsList.noneYet")}
            </div>
          </div>
        </div>

        <section className="bv-glass bv-panel">
          <div className="bv-fpills">
            {(() => {
              const FILTER_LABEL: Record<typeof filter, string> = {
                all: t("app.runsList.filterAll"),
                running: t("app.runAudit.statusRunning"),
                completed: t("app.runAudit.statusCompleted"),
                pending: t("app.runAudit.statusPending"),
                failed: t("app.runAudit.statusFailed"),
              };
              return (["all", "running", "completed", "pending", "failed"] as const).map((id) => (
                <button key={id} type="button" className={`bv-fpill ${filter === id ? "active" : ""}`} onClick={() => setFilter(id)}>
                  <span>{FILTER_LABEL[id]}</span>
                  <span className="bv-fpill-count">{counts[id]}</span>
                </button>
              ));
            })()}
          </div>

          <div className="bv-runs-table" role="table">
            <div className="bv-runs-row bv-runs-head" role="row">
              <span>{t("app.runsList.colPipeline")}</span>
              <span>{t("app.runsList.colCompany")}</span>
              <span>{t("app.runsList.colStatus")}</span>
              <span>{t("app.runsList.colStarted")}</span>
              <span>{t("app.runsList.colSteps")}</span>
              <span style={{ textAlign: "right" }}>{t("app.runsList.colSpend")}</span>
            </div>
            {!loaded ? (
              <div style={{ padding: "16px 4px" }}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="animate-shimmer" style={{ height: 36, marginBottom: 6, borderRadius: 8 }} />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: "32px 8px", textAlign: "center", color: "var(--color-outline)" }}>
                {t("app.runsList.noneInFilter")}
              </div>
            ) : (
              <div className="bv-stagger">
                {filtered.map((r) => (
                  <Link key={r.id} href={`/runs/${r.id}`} role="row" className="bv-runs-row" style={{ textDecoration: "none" }}>
                    <span className="bv-runs-pipeline">
                      <span className="material-symbols-outlined" aria-hidden>account_tree</span>
                      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                        <span style={{ fontWeight: 600, color: "var(--color-on-surface)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.pipelineName ?? r.pipeline?.name ?? r.id}
                        </span>
                        <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11 }}>{r.id.slice(0, 12)}</span>
                      </span>
                    </span>
                    <span className="bv-runs-company">{r.companyName ?? r.pipeline?.companyName ?? "—"}</span>
                    <span><StatusLabel status={(r.status ?? "running").toLowerCase()} /></span>
                    <span className="bv-runs-started">{r.startedAt ?? r.createdAt ? timeAgo(r.startedAt ?? r.createdAt!) : t("app.runsList.queued")}</span>
                    <span className="bv-mono" style={{ color: "var(--color-on-surface-variant)" }}>
                      {typeof r.stepsCompleted === "number" && typeof r.stepsTotal === "number" ? `${r.stepsCompleted} / ${r.stepsTotal}` : "—"}
                    </span>
                    <span style={{ textAlign: "right" }} className="bv-mono">
                      {typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(2)}` : "—"}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {total > PAGE_SIZE && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8 }}>
              <span className="bv-caption">
                {t("app.runsList.pagination", { from: offset + 1, to: Math.min(offset + PAGE_SIZE, total), total })}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="bv-btn bv-btn-ghost bv-btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
                  <span>{t("app.runsList.previous")}</span>
                </button>
                <button type="button" className="bv-btn bv-btn-ghost bv-btn-sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                  <span>{t("app.runsList.next")}</span>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: string }) {
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
