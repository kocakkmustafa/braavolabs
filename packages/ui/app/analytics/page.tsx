"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";
import styles from "./analytics.module.css";

// Forge palette only (arc/ember/molten/steel — no green): COMPLETED was
// previously rendered in emerald green (#34d399), which never belonged to
// the Forge accent set used everywhere else in this restyle. Realigned to
// the same status→color convention as /dashboard and /runs
// (bv-status-completed = arc blue, bv-status-running = ember,
// bv-status-failed = molten red).
const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  COMPLETED:        { bg: "rgba(59,130,246,0.1)",  color: "#3B82F6", border: "rgba(59,130,246,0.2)" },
  RUNNING:          { bg: "rgba(255,122,26,0.1)",  color: "#FF7A1A", border: "rgba(255,122,26,0.2)" },
  FAILED:           { bg: "rgba(255,77,77,0.1)",   color: "#FF4D4D", border: "rgba(255,77,77,0.2)" },
  CANCELLED:        { bg: "rgba(91,100,115,0.1)",  color: "#5B6473", border: "rgba(91,100,115,0.2)" },
  PAUSED:           { bg: "rgba(58,65,80,0.14)",   color: "#8A93A6", border: "rgba(58,65,80,0.3)" },
  WAITING_APPROVAL: { bg: "rgba(255,122,26,0.1)",  color: "#FF7A1A", border: "rgba(255,122,26,0.2)" },
  QUEUED:           { bg: "rgba(109,17,173,0.15)", color: "#e0b6ff", border: "rgba(109,17,173,0.3)" },
};
const defaultStatus = { bg: "rgba(91,100,115,0.1)", color: "#5B6473", border: "rgba(91,100,115,0.2)" };

interface UsageData {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  successRate: number;
}

interface FinanceData {
  totalCostUsd: number;
  runCount: number;
  avgCostPerRun: number;
}

export default function AnalyticsPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [runs, setRuns] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [page, setPage] = useState(0);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<any>(null);
  const [activeRange, setActiveRange] = useState<"7d" | "30d" | "90d">("7d");
  const PAGE_SIZE = 20;

  useEffect(() => {
    if (!token) return;
    api.usage(token).then(setUsage).catch(() => setUsage({ totalRuns: 0, completedRuns: 0, failedRuns: 0, successRate: 0 }));
    api.finance(token).then(setFinance).catch(() => setFinance({ totalCostUsd: 0, runCount: 0, avgCostPerRun: 0 }));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    api.listRuns(token, PAGE_SIZE, page * PAGE_SIZE).then((res) => {
      setRuns(res.runs);
      setTotal(res.total);
    }).catch(() => {});
  }, [token, page]);

  async function viewRun(id: string) {
    sounds.click();
    if (expandedRun === id) {
      setExpandedRun(null);
      setRunDetail(null);
      return;
    }
    setExpandedRun(id);
    try {
      const detail = await api.getRun(token!, id);
      setRunDetail(detail);
    } catch {
      setRunDetail(null);
    }
  }

  function exportCSV(data: any[]) {
    if (data.length === 0) return;
    sounds.success();
    const header = "Company,Pipeline,Status,Steps,Cost,Started\n";
    const rows = data.map((r) =>
      [
        r.pipeline?.company?.name ?? "",
        r.pipeline?.name ?? "",
        r.status,
        r._count?.steps ?? 0,
        r.costUsd ? Number(r.costUsd).toFixed(4) : "0",
        new Date(r.createdAt).toISOString(),
      ].join(",")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#60A5FA" }} />
    </div>
  );

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={`bv-dash max-w-7xl mx-auto px-6 py-8 animate-fade-in bv-mesh ${styles.analyticsShell}`}>
      {/* Page head */}
      <div className="bv-page-head mb-6">
        <div>
          {/* eyebrow — mono "> " kicker (dashboard.module.css .kicker, ported),
              same hardcoded string as before, no i18n change */}
          <div className={styles.kicker}>Workspace</div>
          <h1 className="bv-display gradient-text">{t("app.analytics.title")}</h1>
          <p className="bv-caption mt-1">{t("app.analytics.subtitle")}</p>
        </div>
        <div className="bv-page-head-actions">
          {/* Time range segmented control */}
          <div className="bv-segmented">
            {(["7d", "30d", "90d"] as const).map((r) => (
              <button
                key={r}
                className={activeRange === r ? "active" : ""}
                onClick={() => { sounds.click(); setActiveRange(r); }}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={() => exportCSV(runs)}
            className="bv-btn bv-btn-ghost bv-btn-sm"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>download</span>
            {t("app.analytics.exportCsv")}
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="bv-metrics bv-stagger mb-5">
        {/* Total runs */}
        <div className="bv-glass bv-metric bv-rim" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "var(--bv-cobalt-glow)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">play_circle</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statTotalRuns")}</span>
          </div>
          <div className="bv-metric-value">
            <span className={`bv-display ${styles.metricValue}`}>{usage?.totalRuns ?? "—"}</span>
          </div>
          <div className="bv-metric-delta good">
            <span className="material-symbols-outlined">trending_up</span>
            18% vs prev
          </div>
        </div>

        {/* Success rate */}
        <div className="bv-glass bv-metric bv-rim" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "linear-gradient(90deg, #3B82F6, #60A5FA)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">verified</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statSuccessRate")}</span>
          </div>
          <div className="bv-metric-value">
            <span className={`bv-display ${styles.metricValue}`}>{usage ? `${(usage.successRate * 100).toFixed(1)}` : "—"}</span>
            <span className="bv-metric-suffix">%</span>
          </div>
          <div className="bv-metric-delta good">
            <span className="material-symbols-outlined">trending_up</span>
            2% vs prev
          </div>
        </div>

        {/* Total spend */}
        <div className="bv-glass bv-metric bv-rim" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "linear-gradient(90deg, #60A5FA, #7DD3FC)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">payments</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statTotalCost")}</span>
          </div>
          <div className="bv-metric-value">
            <span className="bv-metric-suffix">$</span>
            <span className={`bv-display ${styles.metricValue}`}>{finance ? finance.totalCostUsd.toFixed(2) : "—"}</span>
          </div>
          <div className="bv-metric-delta good">
            <span className="material-symbols-outlined">trending_up</span>
            6% vs prev
          </div>
        </div>

        {/* Avg run cost */}
        <div className="bv-glass bv-metric bv-rim" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "linear-gradient(90deg, #FF7A1A, #FF4D4D)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">avg_pace</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statAvgRun")}</span>
          </div>
          <div className="bv-metric-value">
            <span className="bv-metric-suffix">$</span>
            <span className={`bv-display ${styles.metricValue}`}>{finance ? finance.avgCostPerRun.toFixed(4) : "—"}</span>
          </div>
          <div className="bv-metric-delta bad">
            <span className="material-symbols-outlined">trending_down</span>
            11% vs prev
          </div>
        </div>
      </div>

      {/* Two-column section: spend trend + agent leaderboard */}
      <div className="bv-twocol mb-5">
        {/* Spend trend chart */}
        <div className="bv-glass bv-panel bv-rim">
          <div className="bv-panel-head">
            <div>
              <p className="bv-micro mb-0.5">Spend over time</p>
              <h2 className="bv-title">Spend Trend</h2>
            </div>
            <div className="bv-panel-head-actions">
              <span className="bv-caption" style={{ color: "var(--bv-text-faint)" }}>
                <span style={{ color: "#60A5FA" }}>—</span> spend &nbsp;
                <span style={{ color: "#7DD3FC" }}>- - -</span> budget
              </span>
            </div>
          </div>
          <SpendChart />
        </div>

        {/* Agent leaderboard */}
        <div className="bv-glass bv-panel bv-rim">
          <div className="bv-panel-head">
            <div>
              <p className="bv-micro mb-0.5">By run count</p>
              <h2 className="bv-title">Agent Leaderboard</h2>
            </div>
          </div>
          <AgentLeaderboard />
        </div>
      </div>

      {/* Tool usage */}
      <div className="bv-glass bv-panel bv-rim mb-5">
        <div className="bv-panel-head">
          <div>
            <p className="bv-micro mb-0.5">Calls this period</p>
            <h2 className="bv-title">Tool Usage</h2>
          </div>
        </div>
        <ToolUsagePanel />
      </div>

      {/* Run breakdown + cost summary */}
      <div className="bv-twocol mb-5">
        <div className="bv-glass bv-panel bv-rim">
          <div className="bv-panel-head">
            <div>
              <p className="bv-micro mb-0.5">Outcomes</p>
              <h2 className="bv-title">{t("app.analytics.runBreakdown")}</h2>
            </div>
          </div>
          {usage ? (
            <div className="flex items-center gap-6">
              <DonutChart
                segments={[
                  { value: usage.completedRuns, color: "#3B82F6", label: t("app.analytics.barCompleted") },
                  { value: usage.failedRuns, color: "#FF4D4D", label: t("app.analytics.barFailed") },
                  { value: Math.max(0, usage.totalRuns - usage.completedRuns - usage.failedRuns), color: "#3A4150", label: t("app.analytics.barOther") },
                ]}
                total={usage.totalRuns}
                runsLabel={t("app.analytics.donutLabel")}
              />
              <div className="flex-1 space-y-3">
                <BarRow label={t("app.analytics.barCompleted")} count={usage.completedRuns} total={usage.totalRuns} color="#3B82F6" />
                <BarRow label={t("app.analytics.barFailed")} count={usage.failedRuns} total={usage.totalRuns} color="#FF4D4D" />
                <BarRow label={t("app.analytics.barOther")} count={usage.totalRuns - usage.completedRuns - usage.failedRuns} total={usage.totalRuns} color="#3A4150" />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32">
              <div className="w-8 h-8 rounded-full border-2 animate-spin" style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#60A5FA" }} />
            </div>
          )}
        </div>

        <div className="bv-glass bv-panel bv-rim">
          <div className="bv-panel-head">
            <div>
              <p className="bv-micro mb-0.5">Billing summary</p>
              <h2 className="bv-title">{t("app.analytics.costSummary")}</h2>
            </div>
          </div>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
                <span className="bv-caption">{t("app.analytics.totalSpent")}</span>
                <span className="bv-numeric text-xl gradient-text">${finance.totalCostUsd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center py-2" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
                <span className="bv-caption">{t("app.analytics.billableRuns")}</span>
                <span className="bv-mono text-on-surface-variant">{finance.runCount}</span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="bv-caption">{t("app.analytics.averagePerRun")}</span>
                <span className="bv-mono text-on-surface-variant">${finance.avgCostPerRun.toFixed(4)}</span>
              </div>
            </div>
          ) : (
            <p className="bv-caption">{t("app.analytics.loading")}</p>
          )}
        </div>
      </div>

      {/* Run History table */}
      <div className="bv-glass bv-rim overflow-hidden">
        <div className="bv-panel-head px-5 py-4" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
          <div>
            <p className="bv-micro mb-0.5">All executions</p>
            <h2 className="bv-title">{t("app.analytics.runHistory")}</h2>
          </div>
        </div>

        {runs.length === 0 ? (
          <div className="p-8 text-center">
            <span className="material-symbols-outlined text-4xl mb-2 block" style={{ color: "var(--color-outline)" }}>history</span>
            <p className="bv-caption">{t("app.analytics.noRuns")}</p>
          </div>
        ) : (
          <div>
            <div className="bv-runs-table px-5 pb-4 pt-2">
              {/* Header */}
              <div className="bv-runs-row bv-runs-head">
                <span>{t("app.analytics.thCompany")} / {t("app.analytics.thPipeline")}</span>
                <span>{t("app.analytics.thCompany")}</span>
                <span>{t("app.analytics.thStatus")}</span>
                <span>{t("app.analytics.thSteps")}</span>
                <span>{t("app.analytics.thCost")}</span>
                <span>{t("app.analytics.thStarted")}</span>
              </div>
              {runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  expanded={expandedRun === r.id}
                  detail={expandedRun === r.id ? runDetail : null}
                  onToggle={() => viewRun(r.id)}
                />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                className="flex items-center justify-between px-5 py-3"
                style={{ borderTop: "1px solid var(--bv-glass-border)" }}
              >
                <span className="bv-caption">
                  {t("app.analytics.showingRange", { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, total), total })}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => { sounds.click(); setPage((p) => Math.max(0, p - 1)); }}
                    disabled={page === 0}
                    className="bv-btn bv-btn-ghost bv-btn-sm disabled:opacity-40"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>chevron_left</span>
                    {t("app.analytics.prev")}
                  </button>
                  <button
                    onClick={() => { sounds.click(); setPage((p) => Math.min(totalPages - 1, p + 1)); }}
                    disabled={page >= totalPages - 1}
                    className="bv-btn bv-btn-ghost bv-btn-sm disabled:opacity-40"
                  >
                    {t("app.analytics.next")}
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>chevron_right</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Spend area chart (SVG, FORGE palette) ──────────────────────────── */
function SpendChart() {
  const SPEND = [180, 220, 260, 240, 310, 360, 420];
  const BUD = [300, 300, 360, 360, 400, 400, 460];
  const W = 580, H = 220, n = SPEND.length, mx = 500;

  function pts(arr: number[]): [number, number][] {
    return arr.map((v, i) => [
      (i / (n - 1)) * W,
      H - (v / mx) * (H - 20) - 10,
    ]);
  }

  const sp = pts(SPEND);
  const bd = pts(BUD);

  function pathD(p: [number, number][]) {
    return p.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  }

  const areaClose = `L${W},${H} L0,${H} Z`;

  return (
    <div style={{ height: 220 }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3B82F6" stopOpacity={0.35} />
            <stop offset="1" stopColor="#3B82F6" stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <line key={i} x1="0" y1={i * 50 + 10} x2={W} y2={i * 50 + 10} stroke="rgba(58,65,80,0.4)" strokeWidth={1} />
        ))}
        {/* Area fill */}
        <path d={`${pathD(sp)} ${areaClose}`} fill="url(#spendGrad)" />
        {/* Budget dashed line */}
        <path d={pathD(bd)} fill="none" stroke="#7DD3FC" strokeWidth={1.5} strokeDasharray="5 5" opacity={0.55} />
        {/* Spend line */}
        <path d={pathD(sp)} fill="none" stroke="#60A5FA" strokeWidth={2} />
        {/* Dots */}
        {sp.map(([cx, cy], i) => (
          <circle key={i} cx={cx.toFixed(1)} cy={cy.toFixed(1)} r={3} fill="#0B0D12" stroke="#60A5FA" strokeWidth={1.5} />
        ))}
      </svg>
    </div>
  );
}

/* ─── Agent leaderboard (static demo data, bar rows) ────────────────── */
const LEAD_DATA: [string, number][] = [
  ["agent:sales", 92],
  ["agent:acquisition", 84],
  ["agent:content", 71],
  ["agent:delivery", 63],
  ["agent:analytics", 48],
  ["agent:ops", 35],
];

function AgentLeaderboard() {
  return (
    <div className="flex flex-col gap-3">
      {LEAD_DATA.map(([name, val]) => (
        <div key={name} className="flex items-center gap-3">
          <span className="bv-mono text-on-surface-variant" style={{ width: 128, flexShrink: 0, fontSize: 12 }}>{name}</span>
          <div className="flex-1 h-2.5 rounded-full" style={{ background: "rgba(20,23,31,0.8)", border: "1px solid var(--bv-glass-border)", overflow: "hidden" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${val}%`, background: "linear-gradient(90deg, #3B82F6, #60A5FA)", transition: "width 1s cubic-bezier(0.16,1,0.3,1)" }}
            />
          </div>
          <span className="bv-mono" style={{ width: 32, textAlign: "right", fontSize: 12, color: "var(--color-on-surface-variant)" }}>{val}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Tool usage breakdown ───────────────────────────────────────────── */
const TOOL_DATA: [string, number, string][] = [
  ["search_market",    82, "#60A5FA"],
  ["compose_outreach", 68, "#60A5FA"],
  ["send_batch",       54, "#7DD3FC"],
  ["rank_leads",       47, "#3B82F6"],
  ["enrich_leads",     31, "#FF7A1A"],
  ["request_approval", 22, "#FF7A1A"],
];

function ToolUsagePanel() {
  return (
    <div className="flex flex-col gap-3 mt-1">
      {TOOL_DATA.map(([name, val, color]) => (
        <div key={name} className="flex items-center gap-3">
          <span className="bv-mono" style={{ width: 148, flexShrink: 0, fontSize: 12, color: "var(--color-on-surface-variant)" }}>{name}</span>
          <div className="flex-1 h-2 rounded-full" style={{ background: "rgba(20,23,31,0.8)", overflow: "hidden" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${val}%`, background: color, transition: "width 1s cubic-bezier(0.16,1,0.3,1)" }}
            />
          </div>
          <span className="bv-mono" style={{ width: 32, textAlign: "right", fontSize: 11, color: "var(--bv-text-faint)" }}>{val}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Bar row (run breakdown) ────────────────────────────────────────── */
function BarRow({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="bv-caption">{label}</span>
        <span className="bv-mono text-on-surface-variant" style={{ fontSize: 12 }}>{count}</span>
      </div>
      <div className="w-full rounded-full h-2" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/* ─── Donut chart (FORGE palette) ────────────────────────────────────── */
function DonutChart({ segments, total, runsLabel }: { segments: { value: number; color: string; label: string }[]; total: number; runsLabel?: string }) {
  const size = 100;
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((seg) => {
      const pct = total > 0 ? seg.value / total : 0;
      const dashLen = pct * circumference;
      const dashOffset = -offset;
      offset += dashLen;
      return { ...seg, dashLen, dashOffset, pct };
    });

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="rgba(58,65,80,0.35)" strokeWidth={strokeWidth}
        />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={arc.color} strokeWidth={strokeWidth}
            strokeDasharray={`${arc.dashLen} ${circumference - arc.dashLen}`}
            strokeDashoffset={arc.dashOffset}
            strokeLinecap="round"
            style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dasharray 0.5s ease" }}
          />
        ))}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span className="bv-numeric" style={{ fontSize: 18, color: "var(--color-on-surface)", lineHeight: 1 }}>{total}</span>
        <span style={{ fontSize: 9, color: "var(--bv-text-faint)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{runsLabel ?? "runs"}</span>
      </div>
    </div>
  );
}

/* ─── Run table row ──────────────────────────────────────────────────── */
function RunRow({ run, expanded, detail, onToggle }: {
  run: any; expanded: boolean; detail: any; onToggle: () => void;
}) {
  const t = useTranslations();
  const s = STATUS_STYLES[run.status] ?? defaultStatus;
  return (
    <>
      <div
        className="bv-runs-row cursor-pointer"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onToggle()}
        aria-expanded={expanded}
      >
        {/* Pipeline + icon */}
        <div className="bv-runs-pipeline">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>account_tree</span>
          <span className="truncate">{run.pipeline?.name ?? "—"}</span>
        </div>
        {/* Company */}
        <span className="bv-runs-company">{run.pipeline?.company?.name ?? "—"}</span>
        {/* Status pill */}
        <span>
          <span className="bv-pill" style={{ background: s.bg, color: s.color, borderColor: s.border }}>
            <span className="bv-dot" style={{ background: s.color, width: 5, height: 5 }} />
            {run.status}
          </span>
        </span>
        {/* Steps */}
        <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>{run._count?.steps ?? 0}</span>
        {/* Cost */}
        <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>{run.costUsd ? `$${Number(run.costUsd).toFixed(4)}` : "—"}</span>
        {/* Started */}
        <span className="bv-runs-started">{new Date(run.createdAt).toLocaleString()}</span>
      </div>

      {expanded && detail && (
        <div className="px-4 pb-4 pt-2" style={{ background: "rgba(255,255,255,0.015)", borderRadius: 10, margin: "2px 0 6px" }}>
          <p className="bv-micro mb-2">{t("app.analytics.runSteps")}</p>
          {detail.steps?.length > 0 ? (
            <div className="flex flex-col gap-2">
              {detail.steps.map((step: any, i: number) => (
                <div
                  key={step.id}
                  className="rounded-xl p-3"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--bv-glass-border)" }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="bv-mono text-xs px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color: "var(--color-outline)" }}>
                      #{i + 1}
                    </span>
                    <span className="bv-title text-sm">{step.stepName}</span>
                    {(() => {
                      const ss = STATUS_STYLES[step.status] ?? defaultStatus;
                      return (
                        <span className="bv-pill" style={{ background: ss.bg, color: ss.color, borderColor: ss.border }}>
                          {step.status}
                        </span>
                      );
                    })()}
                  </div>
                  {step.reasoning && (
                    <p className="bv-caption mt-1" style={{ color: "var(--bv-text-faint)" }}>{t("app.analytics.reasoningPrefix")} {step.reasoning}</p>
                  )}
                  {step.toolCalls?.length > 0 && (
                    <p className="bv-caption mt-1" style={{ color: "var(--bv-text-faint)" }}>{t("app.analytics.toolCallsTemplate", { count: step.toolCalls.length })}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="bv-caption">{t("app.analytics.noSteps")}</p>
          )}
        </div>
      )}
    </>
  );
}
