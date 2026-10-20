"use client";
import { useDisplayFormats } from "../../../lib/useDisplayFormats";

import { useLocalizedFailure } from "../../../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


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


export default function AbTestStudioPage() {
  const displayFormat = useDisplayFormats();
  const describeFailure = useLocalizedFailure();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
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
      setError(describeFailure(err, runtimeCopy("mab698ba77c6c")));
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
      setError(describeFailure(err, runtimeCopy("m0118f642c901", { value0: action })));
    } finally {
      setActionBusy(null);
    }
  }

  const status = test?.status ?? "DRAFT";
  const statusMeta = STATUS_PILL[status] ?? { pill: "bv-pill bv-pill-muted", dot: "bv-dot bv-pending", label: "" };

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
      <div className="bv-dash-shell min-h-screen flex items-center justify-center">
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
      <div className="bv-dash-shell min-h-screen flex items-center justify-center">
        <div className="bv-glass p-8 flex flex-col gap-4 max-w-sm w-full mx-4">
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
    <div className="bv-dash-shell min-h-screen">
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
                  {t(`surface.states.${Object.hasOwn(STATUS_PILL, status) ? status.toLowerCase() : "unknown"}`)}
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
            className="bv-glass flex items-center gap-4 px-6 py-5"
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
                {winnerVariant.name}{" "}{uiText("mbb0e90463fc8")}</span>
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
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>{uiText("m6a6df1ed4210")}{" "}{winnerVariant.name}
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
                className="bv-glass flex flex-col gap-4 p-6"
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
                    background: "var(--color-surface-container-low)",
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
                        <div className={`bv-numeric text-5xl leading-none ${isWinner ? "gradient-text" : "text-[var(--color-on-surface)]"}`}>
                          {displayFormat.number(cell.avg, 4)}
                        </div>
                        <div className="bv-micro">{metricName}</div>
                      </div>
                    ))}

                    {/* Secondary stats row */}
                    {Object.keys(r.metrics).length > 1 && (
                      <div className="flex gap-5">
                        {Object.entries(r.metrics).slice(1, 4).map(([metricName, cell]) => (
                          <div key={`stat-${metricName}`} className="flex flex-col gap-0.5">
                            <span className="bv-mono text-[var(--color-on-surface)]">{displayFormat.number(cell.avg, 4)}</span>
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
                                {displayFormat.number(cell.avg, 4)}
                                <span className="text-[var(--color-outline)] ml-1">±{displayFormat.number(cell.stdDev, 4)}</span>
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
                      color: "var(--color-primary)",
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

        {/* The API exposes aggregates, not a measured time series or CI band. */}
        {results && results.variants.length > 0 && (
          <p className="bv-glass bv-panel text-on-surface-variant" role="note">
            {t("app.abTests.noTimeSeries")}
          </p>
        )}

        {/* ── Improvement summary panel ─────────────────────────── */}
        {results && Object.keys(results.comparison).length > 0 && (
          <div className="bv-glass bv-panel">
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
                  <span className="bv-numeric text-2xl gradient-text">
                    {cmp.improvement} {t("app.abTests.better")}
                  </span>
                  <span className="bv-caption">
                    <span className="text-[var(--color-on-surface)]">{cmp.bestVariant}</span>
                    {" "}
                    <span className="bv-mono">{displayFormat.number(cmp.bestAvg, 4)}</span>
                    {" "}
                    <span className="text-[var(--color-outline)]">{uiText("m1c64caa33ba2")}</span>
                    {" "}
                    <span className="text-[var(--color-on-surface-variant)]">{cmp.worstVariant}</span>
                    {" "}
                    <span className="bv-mono">{displayFormat.number(cmp.worstAvg, 4)}</span>
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
