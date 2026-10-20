"use client";
import { useStateLabel } from "../../lib/useStateLabel";

import { useDisplayFormats } from "../../lib/useDisplayFormats";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { formatNumber, formatCurrency, formatDateTime } from "../../i18n/locales";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";
import { useAppStore, captureAuthSession, isAuthSessionCurrent } from "../../lib/store";

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  COMPLETED:        { bg: "rgba(52,211,153,0.1)",  color: "var(--color-success)", border: "rgba(52,211,153,0.2)" },
  RUNNING:          { bg: "rgba(0,209,255,0.1)",   color: "var(--color-info)", border: "rgba(0,209,255,0.2)" },
  FAILED:           { bg: "rgba(239,68,68,0.1)",   color: "var(--color-error)", border: "rgba(239,68,68,0.2)" },
  CANCELLED:        { bg: "rgba(133,147,153,0.1)", color: "var(--color-on-surface-variant)", border: "rgba(133,147,153,0.2)" },
  PAUSED:           { bg: "rgba(251,191,36,0.1)",  color: "var(--color-warning)", border: "rgba(251,191,36,0.2)" },
  WAITING_APPROVAL: { bg: "rgba(251,146,60,0.1)",  color: "var(--color-warning)", border: "rgba(251,146,60,0.2)" },
  QUEUED:           { bg: "rgba(109,17,173,0.15)", color: "var(--color-accent)", border: "rgba(109,17,173,0.3)" },
};
const defaultStatus = { bg: "rgba(133,147,153,0.1)", color: "var(--color-on-surface-variant)", border: "rgba(133,147,153,0.2)" };

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

function AnalyticsContent() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const locale = useLocale();
  const { token, hydrated } = useAuthGuard();
  const [runs, setRuns] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [page, setPage] = useState(0);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<any>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [runsFailed, setRunsFailed] = useState(false);
  const [runsLoading, setRunsLoading] = useState(true);
  const detailRequest = useRef(0);
  const PAGE_SIZE = 20;

  useEffect(() => {
    if (!token) return;
    let active = true;
    const owner = captureAuthSession();
    const current = () => active && isAuthSessionCurrent(owner);
    setUsage(null); setFinance(null); setSummaryFailed(false);
    api.usage(token).then(value => { if (current()) setUsage(value); })
      .catch(() => { if (current()) setSummaryFailed(true); });
    api.finance(token).then(value => { if (current()) setFinance(value); })
      .catch(() => { if (current()) setSummaryFailed(true); });
    return () => { active = false; detailRequest.current++; };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const owner = captureAuthSession();
    const current = () => active && isAuthSessionCurrent(owner);
    setRunsLoading(true); setRunsFailed(false); setRuns([]); setTotal(0);
    setExpandedRun(null); setRunDetail(null); detailRequest.current++;
    api.listRuns(token, PAGE_SIZE, page * PAGE_SIZE).then(res => {
      if (current()) { setRuns(res.runs); setTotal(res.total); }
    }).catch(() => { if (current()) setRunsFailed(true); })
      .finally(() => { if (current()) setRunsLoading(false); });
    return () => { active = false; detailRequest.current++; };
  }, [token, page]);

  async function viewRun(id: string) {
    sounds.click();
    const request = ++detailRequest.current;
    const owner = captureAuthSession();
    const current = () => request === detailRequest.current && isAuthSessionCurrent(owner);
    setRunDetail(null);
    if (expandedRun === id) { setExpandedRun(null); return; }
    setExpandedRun(id);
    try {
      const detail = await api.getRun(token!, id);
      if (current()) setRunDetail(detail);
    } catch { if (current()) setRunDetail(null); }
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
    <div className="bv-dash max-w-7xl mx-auto px-6 py-8 animate-fade-in bv-mesh">
      {/* Page head */}
      <div className="bv-page-head mb-6">
        <div>
          <p className="bv-micro mb-1" style={{ color: "var(--bv-text-faint)" }}>{uiText("mdd10bd33331e")}</p>
          <h1 className="bv-display gradient-text">{t("app.analytics.title")}</h1>
          <p className="bv-caption mt-1">{t("app.analytics.subtitle")}</p>
        </div>
        <div className="bv-page-head-actions">
          <p className="bv-caption">{t("app.analytics.currentPeriod")}</p>
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
        <div className="bv-glass bv-metric" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "var(--bv-cobalt-glow)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">play_circle</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statTotalRuns")}</span>
          </div>
          <div className="bv-metric-value">
            <span className="bv-display">{formatNumber(usage?.totalRuns, locale)}</span>
          </div>
        </div>

        {/* Success rate */}
        <div className="bv-glass bv-metric" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "linear-gradient(90deg, #3B82F6, #60A5FA)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">verified</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statSuccessRate")}</span>
          </div>
          <div className="bv-metric-value">
            <span className="bv-display">{formatNumber(usage?.successRate, locale, { style: "percent", maximumFractionDigits: 1 })}</span>
          </div>
        </div>

        {/* Total spend */}
        <div className="bv-glass bv-metric" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "linear-gradient(90deg, #60A5FA, #7DD3FC)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">payments</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statTotalCost")}</span>
          </div>
          <div className="bv-metric-value">
            <span className="bv-display">{formatCurrency(finance?.totalCostUsd, "USD", locale)}</span>
          </div>
        </div>

        {/* Avg run cost */}
        <div className="bv-glass bv-metric" style={{ position: "relative" }}>
          <div className="bv-metric-accent" style={{ background: "linear-gradient(90deg, #FF7A1A, #FF4D4D)" }} />
          <div className="bv-metric-head">
            <div className="bv-metric-icon">
              <span className="material-symbols-outlined">avg_pace</span>
            </div>
            <span className="bv-micro">{t("app.analytics.statAvgRun")}</span>
          </div>
          <div className="bv-metric-value">
            <span className="bv-display">{formatCurrency(finance?.avgCostPerRun, "USD", locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span>
          </div>
        </div>
      </div>

      {summaryFailed && <p role="alert" className="bv-caption mb-5">{t("app.analytics.loadFailed")}</p>}

      {/* Run breakdown + cost summary */}
      <div className="bv-twocol mb-5">
        <div className="bv-glass bv-panel">
          <div className="bv-panel-head">
            <div>
              <p className="bv-micro mb-0.5">{uiText("m3c5cae9db9ff")}</p>
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
                <BarRow label={t("app.analytics.barOther")} count={Math.max(0, usage.totalRuns - usage.completedRuns - usage.failedRuns)} total={usage.totalRuns} color="#3A4150" />
              </div>
            </div>
          ) : (
            <p className="bv-caption">{summaryFailed ? t("app.analytics.unavailable") : t("app.analytics.loading")}</p>
          )}
        </div>

        <div className="bv-glass bv-panel">
          <div className="bv-panel-head">
            <div>
              <p className="bv-micro mb-0.5">{uiText("me472804666c8")}</p>
              <h2 className="bv-title">{t("app.analytics.costSummary")}</h2>
            </div>
          </div>
          {finance ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
                <span className="bv-caption">{t("app.analytics.totalSpent")}</span>
                <span className="bv-numeric text-xl gradient-text">{formatCurrency(finance.totalCostUsd, "USD", locale)}</span>
              </div>
              <div className="flex justify-between items-center py-2" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
                <span className="bv-caption">{t("app.analytics.billableRuns")}</span>
                <span className="bv-mono text-on-surface-variant">{formatNumber(finance.runCount, locale)}</span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="bv-caption">{t("app.analytics.averagePerRun")}</span>
                <span className="bv-mono text-on-surface-variant">{formatCurrency(finance.avgCostPerRun, "USD", locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span>
              </div>
            </div>
          ) : (
            <p className="bv-caption">{summaryFailed ? t("app.analytics.unavailable") : t("app.analytics.loading")}</p>
          )}
        </div>
      </div>

      {/* Run History table */}
      <div className="bv-glass overflow-hidden">
        <div className="bv-panel-head px-5 py-4" style={{ borderBottom: "1px solid var(--bv-glass-border)" }}>
          <div>
            <p className="bv-micro mb-0.5">{uiText("m4176e1045b7d")}</p>
            <h2 className="bv-title">{t("app.analytics.runHistory")}</h2>
          </div>
        </div>

        {runsLoading || runsFailed ? <p role={runsFailed ? "alert" : "status"} className="p-8 bv-caption">{t(runsFailed ?"app.analytics.loadFailed" :"app.analytics.loading")}</p> : runs.length === 0 ? (
          <div className="p-8 text-center">
            <span className="material-symbols-outlined text-4xl mb-2 block" style={{ color: "var(--color-outline)" }}>history</span>
            <p className="bv-caption">{t("app.analytics.noRuns")}</p>
          </div>
        ) : (
          <div>
            <div className="bv-runs-table px-5 pb-4 pt-2 overflow-x-auto">
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
  const uiText = useLegacyTranslations("uiCopy");
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
        <span style={{ fontSize: 9, color: "var(--bv-text-faint)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{runsLabel ??uiText("m138dacd53320")}</span>
      </div>
    </div>
  );
}

/* ─── Run table row ──────────────────────────────────────────────────── */
function RunRow({ run, expanded, detail, onToggle }: {
  run: any; expanded: boolean; detail: any; onToggle: () => void;
}) {
  const stateLabel = useStateLabel();
  const displayFormat = useDisplayFormats();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const t = useTranslations();
  const locale = useLocale();
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
            {stateLabel(run.status)}
          </span>
        </span>
        {/* Steps */}
        <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>{run._count?.steps ?? 0}</span>
        {/* Cost */}
        <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>{displayFormat.usd(run.costUsd)}</span>
        {/* Started */}
        <span className="bv-runs-started">{formatDateTime(run.createdAt, locale, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC</span>
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
                          {stateLabel(step.status)}
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

export default function AnalyticsPage() {
  const revision = useAppStore(state => state.sessionRevision);
  const { token, hydrated } = useAuthGuard();
  return hydrated && token ? <AnalyticsContent key={revision} /> : null;
}
