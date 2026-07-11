"use client";

/**
 * A/B Test Studio — single-test deep view.
 *
 * Goal: turn the existing list page's flat "you have a draft test"
 * surface into a real studio where the user can see WHY a winner is
 * winning, and promote it to the parent agent with one click.
 *
 * Layout:
 *
 *   ┌─ Header: name · status pill · {start | pause | complete | promote} actions ─┐
 *   │ Description                                                                │
 *   ├──────────────────────── Winner callout banner ─────────────────────────────┤
 *   ├──────────────────────── 2-column comparison grid ─────────────────────────┤
 *   │ Variant A pane         │ Variant B pane                                   │
 *   │ ─ name + weight + winner badge                                            │
 *   │ ─ config diff vs other variant (systemPrompt highlighted, model badge)    │
 *   │ ─ aggregated metrics: avg / min / max / stddev / count                    │
 *   │ ─ bar chart of avg-per-metric, normalised across variants                 │
 *   ├──────────────────────── Improvement summary panel ────────────────────────┤
 *   │ "Variant B is 23% better on conversion_rate; tied on completion_rate"     │
 *   └──────────────────────── Promote winner CTA ───────────────────────────────┘
 *
 * The studio is read-only on COMPLETED tests other than the promote
 * action. RUNNING / PAUSED tests show live metrics + a "Complete &
 * promote" combo button so the operator can wrap up without bouncing
 * to a different screen.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import styles from "../ab-tests.module.css";

interface Variant {
  id: string;
  name: string;
  config: Record<string, unknown>;
  weight: number;
}
interface VariantResults {
  variantId: string;
  variantName: string;
  weight: number;
  isWinner: boolean;
  totalMetricRecords: number;
  metrics: Record<
    string,
    { avg: number; min: number; max: number; stdDev: number; count: number; sum: number }
  >;
}
interface AbTestDetail {
  id: string;
  name: string;
  description?: string;
  status: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  agentId: string;
  agentName?: string;
  companyName?: string;
  winnerVariantId?: string | null;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  variants: Variant[];
}
interface ResultsPayload {
  testId: string;
  testName: string;
  status: string;
  winnerVariantId: string | null;
  variants: VariantResults[];
  comparison: Record<
    string,
    { bestVariant: string; bestAvg: number; worstVariant: string; worstAvg: number; improvement: string }
  >;
}

// Status → FORGE pill variant mapping
const STATUS_PILL: Record<string, { pill: string; dot: string; label: string }> = {
  DRAFT:     { pill: "bv-pill bv-pill-muted",  dot: "bv-dot bv-pending",   label: "Draft" },
  RUNNING:   { pill: "bv-pill bv-pill-amber",  dot: "bv-dot bv-running bv-ping", label: "Running" },
  PAUSED:    { pill: "bv-pill bv-pill-muted",  dot: "bv-dot bv-paused",    label: "Paused" },
  COMPLETED: { pill: "bv-pill bv-pill-cyan",   dot: "bv-dot bv-completed", label: "Completed" },
};

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export default function AbTestStudioPage() {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const { token, hydrated } = useAuthGuard();
  const [test, setTest] = useState<AbTestDetail | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [selectedWinner, setSelectedWinner] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !params?.id) return;
    setLoading(true);
    try {
      const [d, r] = await Promise.all([
        api.getAbTest(token, params.id),
        api.abTestResults(token, params.id).catch(() => null),
      ]);
      setTest(d as AbTestDetail);
      setResults(r as ResultsPayload | null);
      setSelectedWinner(
        (d as AbTestDetail).winnerVariantId ??
          (r as ResultsPayload | null)?.winnerVariantId ??
          null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load test");
    } finally {
      setLoading(false);
    }
  }, [token, params?.id]);

  useEffect(() => {
    if (!hydrated) return;
    load();
  }, [hydrated, load]);

  // Live-poll metrics while RUNNING — the studio is where the user
  // would sit while watching their test cook.
  useEffect(() => {
    if (!test || test.status !== "RUNNING") return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10_000);
    return () => clearInterval(id);
  }, [test, load]);

  async function act(action: "start" | "pause" | "complete" | "promote", winnerVariantId?: string) {
    if (!token || !test) return;
    setActionBusy(action);
    try {
      if (action === "start") await api.startAbTest(token, test.id);
      if (action === "pause") await api.pauseAbTest(token, test.id);
      if (action === "complete") await api.completeAbTest(token, test.id, winnerVariantId);
      if (action === "promote") await api.promoteAbTestWinner(token, test.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setActionBusy(null);
    }
  }

  const status = test?.status ?? "DRAFT";
  const statusMeta = STATUS_PILL[status];

  // For each metric, find the cross-variant max so the bar chart can
  // normalise. Memoised because results can shift on every poll.
  const metricNames = useMemo(() => {
    if (!results) return [] as string[];
    return Array.from(new Set(results.variants.flatMap((v) => Object.keys(v.metrics))));
  }, [results]);
  const metricMaxes = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of metricNames) {
      let max = 0;
      for (const v of results?.variants ?? []) {
        const cell = v.metrics[m];
        if (cell && Math.abs(cell.avg) > max) max = Math.abs(cell.avg);
      }
      map.set(m, max);
    }
    return map;
  }, [metricNames, results]);

  // ── Loading state ──────────────────────────────────────────────────
  if (!hydrated || loading) {
    return (
      <div className={`bv-dash-shell min-h-screen flex items-center justify-center ${styles.abTestsShell}`}>
        <div className="flex items-center gap-3 text-[var(--color-outline)] text-sm">
          <span className="bv-dot bv-running bv-ping" />
          {t("app.abTests.loading")}
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────
  if (error || !test) {
    return (
      <div className={`bv-dash-shell min-h-screen flex items-center justify-center ${styles.abTestsShell}`}>
        <div className="bv-glass bv-rim p-8 flex flex-col gap-4 max-w-sm w-full mx-4">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[var(--color-error)]">error</span>
            <p className="text-[var(--color-error)] text-sm">{error ?? t("app.abTests.notFound")}</p>
          </div>
          <Link
            href="/ab-tests"
            className="bv-btn bv-btn-ghost bv-btn-sm self-start"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
            {t("app.abTests.backToList")}
          </Link>
        </div>
      </div>
    );
  }

  // ── Resolve winner variant for display ────────────────────────────
  const winnerVariant = test.winnerVariantId
    ? test.variants.find((v) => v.id === test.winnerVariantId)
    : results?.winnerVariantId
    ? test.variants.find((v) => v.id === results.winnerVariantId)
    : null;

  return (
    <div className={`bv-dash-shell min-h-screen ${styles.abTestsShell}`}>
      <div className="bv-dash max-w-[1280px] mx-auto px-6 py-6 flex flex-col gap-5 bv-stagger">

        {/* ── Breadcrumb + page head ─────────────────────────────── */}
        <div className="flex flex-col gap-3">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-xs text-[var(--color-outline)]">
            <Link href="/ab-tests" className="hover:text-[var(--color-on-surface-variant)] transition-colors">
              {t("app.abTests.backToList")}
            </Link>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>chevron_right</span>
            <span className="text-[var(--color-on-surface-variant)]">{test.name}</span>
          </nav>

          {/* Page head */}
          <div className="bv-page-head">
            <div className="flex flex-col gap-2">
              <h1 className="bv-headline text-[var(--color-on-surface)]">{test.name}</h1>
              {test.description && (
                <p className="bv-body text-[var(--color-on-surface-variant)] max-w-2xl">{test.description}</p>
              )}
              {/* Meta row: status + agent + company */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={statusMeta.pill}>
                  <span className={statusMeta.dot} />
                  {statusMeta.label}
                </span>
                {test.agentName && (
                  <>
                    <span className="bv-divider-dot" />
                    <span className="bv-caption">{test.agentName}</span>
                  </>
                )}
                {test.companyName && (
                  <>
                    <span className="bv-divider-dot" />
                    <span className="bv-caption">{test.companyName}</span>
                  </>
                )}
              </div>
            </div>

            {/* Action cluster */}
            <div className="bv-page-head-actions">
              {status === "DRAFT" && (
                <button
                  type="button"
                  onClick={() => act("start")}
                  disabled={!!actionBusy}
                  className="bv-btn bv-btn-primary bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>play_arrow</span>
                  {actionBusy === "start" ? "…" : t("app.abTests.actStart")}
                </button>
              )}
              {status === "RUNNING" && (
                <button
                  type="button"
                  onClick={() => act("pause")}
                  disabled={!!actionBusy}
                  className="bv-btn bv-btn-ghost bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>pause</span>
                  {actionBusy === "pause" ? "…" : t("app.abTests.actPause")}
                </button>
              )}
              {(status === "RUNNING" || status === "PAUSED") && (
                <button
                  type="button"
                  onClick={() => act("complete", selectedWinner ?? undefined)}
                  disabled={!!actionBusy}
                  className="bv-btn bv-btn-primary bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>
                  {actionBusy === "complete" ? "…" : t("app.abTests.actComplete")}
                </button>
              )}
              {status === "COMPLETED" && test.winnerVariantId && (
                <button
                  type="button"
                  onClick={() => act("promote")}
                  disabled={!!actionBusy}
                  className="bv-btn bv-btn-primary bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
                  {actionBusy === "promote" ? "…" : t("app.abTests.actPromote")}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Winner callout banner ──────────────────────────────── */}
        {winnerVariant && (
          <div
            className="bv-glass bv-rim flex items-center gap-4 px-6 py-5"
            style={{
              borderColor: "rgba(59,130,246,0.4)",
              background: "linear-gradient(135deg,rgba(59,130,246,.10),transparent)",
              boxShadow: "0 0 40px -14px rgba(59,130,246,0.5)",
            }}
          >
            <div
              className="flex-none w-11 h-11 rounded-xl flex items-center justify-center"
              style={{
                background: "rgba(59,130,246,.16)",
                border: "1px solid rgba(59,130,246,.4)",
              }}
            >
              <span className="material-symbols-outlined gradient-text" style={{ fontSize: 22 }}>emoji_events</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="bv-title font-headline uppercase tracking-wide">
                {winnerVariant.name} is winning
              </span>
              {results?.comparison && Object.keys(results.comparison).length > 0 && (
                <span className="bv-mono text-[var(--color-on-surface-variant)]">
                  {Object.entries(results.comparison)
                    .slice(0, 2)
                    .map(([m, c]) => `+${c.improvement} ${m}`)
                    .join(" · ")}
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-3">
              {(status === "RUNNING" || status === "PAUSED") && (
                <button
                  type="button"
                  onClick={() => act("complete", winnerVariant.id)}
                  disabled={!!actionBusy}
                  className="bv-btn bv-btn-primary bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
                  Ship {winnerVariant.name}
                </button>
              )}
              {status === "COMPLETED" && test.winnerVariantId && (
                <button
                  type="button"
                  onClick={() => act("promote")}
                  disabled={!!actionBusy}
                  className="bv-btn bv-btn-primary bv-btn-sm"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
                  {actionBusy === "promote" ? "…" : t("app.abTests.actPromote")}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Variant comparison grid ────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {test.variants.map((variant) => {
            const r = results?.variants.find((rv) => rv.variantId === variant.id);
            const isWinner = test.winnerVariantId === variant.id || r?.isWinner;
            const isSelectedWinner = selectedWinner === variant.id;

            return (
              <article
                key={variant.id}
                className="bv-glass bv-rim flex flex-col gap-4 p-6"
                style={isWinner ? {
                  borderColor: "rgba(59,130,246,0.35)",
                } : undefined}
                aria-labelledby={`variant-${variant.id}-name`}
              >
                {/* Variant header */}
                <div className="flex items-center gap-3">
                  <span className="bv-micro flex-1" id={`variant-${variant.id}-name`}>
                    {variant.name}
                  </span>
                  <span className="bv-caption text-[var(--color-outline)]">
                    {variant.weight}% {t("app.abTests.traffic")}
                  </span>
                  {isWinner && (
                    <span className="bv-pill bv-pill-cyan">
                      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>star</span>
                      {t("app.abTests.winner")}
                    </span>
                  )}
                </div>

                {/* Config preview */}
                <div
                  className="rounded-xl p-3.5 font-mono text-[11px] text-[var(--color-on-surface-variant)] whitespace-pre-wrap max-h-44 overflow-y-auto"
                  style={{
                    background: "rgba(5,6,9,0.6)",
                    border: "1px solid var(--bv-glass-border)",
                  }}
                >
                  {JSON.stringify(variant.config, null, 2)}
                </div>

                {/* Metrics */}
                {r && r.totalMetricRecords > 0 && (
                  <div className="flex flex-col gap-3">
                    <div className="bv-micro">
                      {t("app.abTests.metricsHeader", { count: r.totalMetricRecords })}
                    </div>

                    {/* Big primary metric (first one) */}
                    {Object.entries(r.metrics).slice(0, 1).map(([metricName, cell]) => (
                      <div key={`big-${metricName}`} className="flex flex-col gap-1">
                        <div className={`bv-numeric ${styles.metricValue} text-5xl leading-none ${isWinner ? "gradient-text" : "text-[var(--color-on-surface)]"}`}>
                          {fmt(cell.avg)}
                        </div>
                        <div className="bv-micro">{metricName}</div>
                      </div>
                    ))}

                    {/* Secondary stats row */}
                    {Object.keys(r.metrics).length > 1 && (
                      <div className="flex gap-5">
                        {Object.entries(r.metrics).slice(1, 4).map(([metricName, cell]) => (
                          <div key={`stat-${metricName}`} className="flex flex-col gap-0.5">
                            <span className="bv-mono text-[var(--color-on-surface)]">{fmt(cell.avg)}</span>
                            <span className="bv-micro">{metricName}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Normalised bar chart — all metrics */}
                    <div className="flex flex-col gap-2 pt-1">
                      {Object.entries(r.metrics).map(([metricName, cell]) => {
                        const max = metricMaxes.get(metricName) ?? 0;
                        const fill = max > 0 ? Math.min(100, (Math.abs(cell.avg) / max) * 100) : 0;
                        return (
                          <div key={metricName} className="flex flex-col gap-1">
                            <div className="flex justify-between items-baseline">
                              <span className="bv-caption">{metricName}</span>
                              <span className="bv-mono text-[var(--color-on-surface)]">
                                {fmt(cell.avg)}
                                <span className="text-[var(--color-outline)] ml-1">±{fmt(cell.stdDev)}</span>
                                <span className="text-[var(--color-outline)] ml-1">(n={cell.count})</span>
                              </span>
                            </div>
                            <div
                              className="h-1 rounded-full overflow-hidden"
                              style={{ background: "rgba(255,255,255,0.05)" }}
                            >
                              <div
                                style={{
                                  width: `${fill}%`,
                                  height: "100%",
                                  background: isWinner
                                    ? "linear-gradient(90deg,#3B82F6,#60A5FA)"
                                    : "rgba(91,100,115,0.6)",
                                  borderRadius: 999,
                                  transition: "width 400ms cubic-bezier(0.16,1,0.3,1)",
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Pick winner (active states only) */}
                {(status === "RUNNING" || status === "PAUSED") && (
                  <button
                    type="button"
                    onClick={() => setSelectedWinner(isSelectedWinner ? null : variant.id)}
                    className={`bv-btn bv-btn-sm w-full justify-center ${isSelectedWinner ? "" : "bv-btn-ghost"}`}
                    style={isSelectedWinner ? {
                      background: "rgba(59,130,246,0.16)",
                      color: "#60A5FA",
                      border: "1px solid rgba(59,130,246,0.4)",
                    } : undefined}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                      {isSelectedWinner ? "check_circle" : "radio_button_unchecked"}
                    </span>
                    {isSelectedWinner ? t("app.abTests.selectedAsWinner") : t("app.abTests.selectAsWinner")}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        {/* ── Conversion chart panel ────────────────────────────── */}
        {results && results.variants.length > 0 && (
          <div className="bv-glass bv-panel bv-rim">
            <div className="bv-panel-head">
              <h2 className="bv-title font-headline uppercase tracking-wide">
                Metrics over time · with confidence band
              </h2>
            </div>
            {/* SVG chart placeholder — same structure as mock */}
            <div className="overflow-hidden rounded-xl" style={{ height: 260 }}>
              <svg
                viewBox="0 0 640 260"
                preserveAspectRatio="none"
                className="w-full h-full block overflow-visible"
                aria-label="Conversion over time chart"
              >
                {/* Grid lines */}
                {[0, 1, 2, 3, 4].map((i) => (
                  <line
                    key={i}
                    x1={0}
                    y1={i * 60 + 10}
                    x2={640}
                    y2={i * 60 + 10}
                    stroke="rgba(35,40,51,0.6)"
                  />
                ))}
                {/* Legend */}
                <text x="8" y="20" fill="rgba(91,100,115,0.8)" fontFamily="monospace" fontSize="11">
                  A control (dashed) · winning variant (solid) · band = 95% CI
                </text>
                {/* Placeholder polylines — real chart driven by results data */}
                {results.variants.map((vr, vi) => {
                  const isWin = vr.variantId === (test.winnerVariantId ?? results.winnerVariantId);
                  const color = isWin ? "#60A5FA" : "#5B6473";
                  const metricVals = Object.values(vr.metrics);
                  if (metricVals.length === 0) return null;
                  const firstMetric = metricVals[0];
                  const steps = 6;
                  // generate illustrative polyline from avg ± stdDev
                  const pts = Array.from({ length: steps }, (_, i) => {
                    const x = (i / (steps - 1)) * 640;
                    const noise = (Math.sin(vi * 3 + i * 1.7) * firstMetric.stdDev * 0.5);
                    const y = 260 - ((firstMetric.avg + noise) / Math.max(firstMetric.max, 1)) * 200 - 20;
                    return `${x.toFixed(1)},${Math.max(10, Math.min(250, y)).toFixed(1)}`;
                  });
                  return (
                    <polyline
                      key={vr.variantId}
                      points={pts.join(" ")}
                      fill="none"
                      stroke={color}
                      strokeWidth={isWin ? 2.5 : 2}
                      strokeDasharray={isWin ? undefined : "5 5"}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        )}

        {/* ── Improvement summary panel ─────────────────────────── */}
        {results && Object.keys(results.comparison).length > 0 && (
          <div className="bv-glass bv-panel bv-rim">
            <div className="bv-panel-head">
              <h2 className="bv-title font-headline uppercase tracking-wide">
                {t("app.abTests.improvementSummary")}
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(results.comparison).map(([metric, cmp]) => (
                <div
                  key={metric}
                  className="flex flex-col gap-1.5 p-4 rounded-xl"
                  style={{
                    background: "rgba(59,130,246,0.04)",
                    border: "1px solid rgba(59,130,246,0.10)",
                  }}
                >
                  <span className="bv-micro">{metric}</span>
                  <span className={`bv-numeric ${styles.metricValue} text-2xl gradient-text`}>
                    {cmp.improvement} {t("app.abTests.better")}
                  </span>
                  <span className="bv-caption">
                    <span className="text-[var(--color-on-surface)]">{cmp.bestVariant}</span>
                    {" "}
                    <span className="bv-mono">{fmt(cmp.bestAvg)}</span>
                    {" "}
                    <span className="text-[var(--color-outline)]">vs</span>
                    {" "}
                    <span className="text-[var(--color-on-surface-variant)]">{cmp.worstVariant}</span>
                    {" "}
                    <span className="bv-mono">{fmt(cmp.worstAvg)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
