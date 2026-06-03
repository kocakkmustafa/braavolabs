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
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!token) return;
    setLoaded(false);
    api.listRuns(token, PAGE_SIZE, offset)
      .then((d) => { setRuns(d.runs ?? []); setTotal(d.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [token, offset]);

  const filtered = useMemo(() => {
    let result = filter === "all" ? runs : runs.filter((r) => (r.status ?? "").toLowerCase() === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (r) =>
          (r.pipelineName ?? r.pipeline?.name ?? r.id).toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          (r.companyName ?? r.pipeline?.companyName ?? "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [runs, filter, query]);

  const counts = useMemo(() => ({
    all: runs.length,
    running: runs.filter((r) => (r.status ?? "").toLowerCase() === "running").length,
    completed: runs.filter((r) => (r.status ?? "").toLowerCase() === "completed").length,
    pending: runs.filter((r) => (r.status ?? "").toLowerCase() === "pending").length,
    failed: runs.filter((r) => (r.status ?? "").toLowerCase() === "failed").length,
  }), [runs]);

  if (!hydrated || !token) {
    return (
      <div className="bv-dash bv-dash-shell flex items-center justify-center min-h-screen">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "rgba(59,130,246,0.2)", borderTopColor: "var(--bv-cobalt-glow)" }}
        />
      </div>
    );
  }

  return (
    <div className="bv-dash bv-dash-shell">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── Page head ── */}
        <div className="bv-page-head bv-rise" style={{ marginBottom: 24 }}>
          <div>
            <div className="bv-micro" style={{ marginBottom: 6 }}>{t("app.runsList.activity")}</div>
            <h1 className="bv-display" style={{ margin: 0 }}>{t("app.runsList.title")}</h1>
            <div className="bv-caption" style={{ marginTop: 8 }}>
              {total > 0 ? t("app.runsList.totalCount", { n: total }) : t("app.runsList.noneYet")}
            </div>
          </div>
        </div>

        {/* ── Filters + search bar ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          {/* Search input */}
          <div style={{ flex: 1, minWidth: 200, maxWidth: 340, position: "relative" }}>
            <span
              className="material-symbols-outlined"
              aria-hidden
              style={{
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: 16,
                color: "var(--color-outline)",
                pointerEvents: "none",
              }}
            >
              search
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search runs…"
              style={{
                width: "100%",
                background: "var(--color-surface-container-low)",
                border: "1px solid var(--color-outline-variant)",
                borderRadius: 11,
                padding: "10px 14px 10px 38px",
                color: "var(--color-on-surface)",
                fontSize: 14,
                outline: "none",
                fontFamily: "var(--bv-font-mono)",
                transition: "border-color 200ms, box-shadow 200ms",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--bv-cobalt-glow)";
                e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.18)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--color-outline-variant)";
                e.currentTarget.style.boxShadow = "none";
              }}
            />
          </div>

          {/* Filter chips */}
          <div className="bv-fpills">
            {(() => {
              const FILTER_LABEL: Record<typeof filter, string> = {
                all: t("app.runsList.filterAll"),
                running: t("app.runAudit.statusRunning"),
                completed: t("app.runAudit.statusCompleted"),
                pending: t("app.runAudit.statusPending"),
                failed: t("app.runAudit.statusFailed"),
              };
              const FILTER_DOT: Record<typeof filter, string | null> = {
                all: null,
                running: "bv-running",
                completed: "bv-completed",
                pending: "bv-pending",
                failed: "bv-failed",
              };
              return (["all", "running", "completed", "pending", "failed"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`bv-fpill${filter === id ? " active" : ""}`}
                  onClick={() => setFilter(id)}
                >
                  {FILTER_DOT[id] && (
                    <span
                      className={`bv-dot ${FILTER_DOT[id]}${id === "running" ? " bv-ping" : ""}`}
                      aria-hidden
                    />
                  )}
                  <span>{FILTER_LABEL[id]}</span>
                  <span className="bv-fpill-count">{counts[id]}</span>
                </button>
              ));
            })()}
          </div>
        </div>

        {/* ── Runs table card ── */}
        <section className="bv-glass bv-panel" style={{ padding: 0, overflow: "hidden" }}>
          {/* Table */}
          <div className="bv-runs-table" role="table">
            {/* Header */}
            <div className="bv-runs-row bv-runs-head" role="row" style={{ padding: "12px 20px" }}>
              <span>
                <span className="material-symbols-outlined" aria-hidden style={{ fontSize: 12, marginRight: 6 }}>
                  play_circle
                </span>
                {t("app.runsList.colPipeline")}
              </span>
              <span>{t("app.runsList.colCompany")}</span>
              <span>{t("app.runsList.colStatus")}</span>
              <span>{t("app.runsList.colStarted")}</span>
              <span>{t("app.runsList.colSteps")}</span>
              <span style={{ textAlign: "right" }}>{t("app.runsList.colSpend")}</span>
            </div>

            {/* Body */}
            {!loaded ? (
              <div style={{ padding: "12px 20px" }}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="animate-shimmer"
                    style={{ height: 44, marginBottom: 6, borderRadius: 10 }}
                  />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  color: "var(--color-outline)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 32, color: "var(--color-outline-variant)" }}
                >
                  history_toggle_off
                </span>
                <span className="bv-caption">{t("app.runsList.noneInFilter")}</span>
              </div>
            ) : (
              <div className="bv-stagger" style={{ padding: "0 8px 8px" }}>
                {filtered.map((r) => (
                  <Link
                    key={r.id}
                    href={`/runs/${r.id}`}
                    role="row"
                    className="bv-runs-row"
                    style={{ textDecoration: "none", padding: "13px 12px", borderRadius: 10 }}
                  >
                    {/* Pipeline name + id */}
                    <span className="bv-runs-pipeline">
                      <span
                        className="material-symbols-outlined"
                        aria-hidden
                        style={{ fontSize: 16, flexShrink: 0 }}
                      >
                        account_tree
                      </span>
                      <span
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            color: "var(--color-on-surface)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {r.pipelineName ?? r.pipeline?.name ?? r.id}
                        </span>
                        <span
                          className="bv-mono"
                          style={{ color: "var(--color-outline)", fontSize: 11 }}
                        >
                          {r.id.slice(0, 12)}
                        </span>
                      </span>
                    </span>

                    {/* Company */}
                    <span className="bv-runs-company">
                      {r.companyName ?? r.pipeline?.companyName ?? "—"}
                    </span>

                    {/* Status */}
                    <span>
                      <StatusLabel status={(r.status ?? "running").toLowerCase()} />
                    </span>

                    {/* Started */}
                    <span className="bv-runs-started">
                      {r.startedAt ?? r.createdAt
                        ? timeAgo(r.startedAt ?? r.createdAt!)
                        : t("app.runsList.queued")}
                    </span>

                    {/* Steps */}
                    <span
                      className="bv-mono"
                      style={{ color: "var(--color-on-surface-variant)" }}
                    >
                      {typeof r.stepsCompleted === "number" && typeof r.stepsTotal === "number"
                        ? `${r.stepsCompleted} / ${r.stepsTotal}`
                        : "—"}
                    </span>

                    {/* Cost */}
                    <span
                      className="bv-mono"
                      style={{
                        textAlign: "right",
                        color:
                          typeof r.costUsd === "number" && r.costUsd > 0
                            ? "var(--color-on-surface)"
                            : "var(--color-outline)",
                      }}
                    >
                      {typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(2)}` : "—"}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 20px 16px",
                borderTop: "1px solid var(--bv-glass-border)",
              }}
            >
              <span className="bv-caption">
                {t("app.runsList.pagination", {
                  from: offset + 1,
                  to: Math.min(offset + PAGE_SIZE, total),
                  total,
                })}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="bv-btn bv-btn-ghost bv-btn-sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                    arrow_back
                  </span>
                  <span>{t("app.runsList.previous")}</span>
                </button>
                <button
                  type="button"
                  className="bv-btn bv-btn-ghost bv-btn-sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  <span>{t("app.runsList.next")}</span>
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                    arrow_forward
                  </span>
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
    status === "running"          ? t("app.runAudit.statusRunning") :
    status === "completed"        ? t("app.runAudit.statusCompleted") :
    status === "paused"           ? t("app.runAudit.statusPaused") :
    status === "failed"           ? t("app.runAudit.statusFailed") :
    status === "cancelled"        ? t("app.runAudit.statusCancelled") :
    status === "waiting_approval" ? t("app.runAudit.statusWaiting") :
    t("app.runAudit.statusPending");
  const cls =
    status === "waiting_approval" || status === "pending" ? "bv-pending" : status;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className={`bv-dot bv-${cls}${status === "running" ? " bv-ping" : ""}`}
        aria-hidden
      />
      <span style={{ fontSize: 12, color: "var(--color-on-surface-variant)" }}>{label}</span>
    </span>
  );
}
