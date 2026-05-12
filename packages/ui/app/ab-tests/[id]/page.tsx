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

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string; label: string }> = {
  DRAFT: { bg: "rgba(133,147,153,0.12)", color: "#859399", border: "rgba(133,147,153,0.2)", label: "Draft" },
  RUNNING: { bg: "rgba(0,209,255,0.12)", color: "#00d1ff", border: "rgba(0,209,255,0.2)", label: "Running" },
  PAUSED: { bg: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "rgba(251,191,36,0.2)", label: "Paused" },
  COMPLETED: { bg: "rgba(52,211,153,0.12)", color: "#34d399", border: "rgba(52,211,153,0.2)", label: "Completed" },
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
  const statusStyle = STATUS_STYLES[status];

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

  if (!hydrated || loading) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ color: "var(--color-outline)", fontSize: 13 }}>{t("app.abTests.loading")}</div>
      </main>
    );
  }
  if (error || !test) {
    return (
      <main style={{ padding: 24 }}>
        <div style={{ color: "#f87171", fontSize: 13 }}>
          {error ?? t("app.abTests.notFound")}
        </div>
        <Link href="/ab-tests" style={{ fontSize: 12, color: "var(--color-primary)" }}>
          ← {t("app.abTests.backToList")}
        </Link>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <Link
            href="/ab-tests"
            style={{ fontSize: 12, color: "var(--color-outline)", textDecoration: "none" }}
          >
            ← {t("app.abTests.backToList")}
          </Link>
          <h1 style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif", marginTop: 6 }}>
            {test.name}
          </h1>
          {test.description && (
            <p style={{ fontSize: 13, color: "var(--color-on-surface-variant)", marginTop: 4 }}>
              {test.description}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 11, color: "var(--color-outline)" }}>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                background: statusStyle.bg,
                color: statusStyle.color,
                border: `1px solid ${statusStyle.border}`,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              {statusStyle.label}
            </span>
            <span>{test.agentName ?? "—"}</span>
            <span>·</span>
            <span>{test.companyName ?? "—"}</span>
          </div>
        </div>

        {/* Action cluster */}
        <div style={{ display: "flex", gap: 8 }}>
          {status === "DRAFT" && (
            <button
              type="button"
              onClick={() => act("start")}
              disabled={!!actionBusy}
              style={primaryBtn}
            >
              {actionBusy === "start" ? "…" : t("app.abTests.actStart")}
            </button>
          )}
          {status === "RUNNING" && (
            <button
              type="button"
              onClick={() => act("pause")}
              disabled={!!actionBusy}
              style={ghostBtn}
            >
              {actionBusy === "pause" ? "…" : t("app.abTests.actPause")}
            </button>
          )}
          {(status === "RUNNING" || status === "PAUSED") && (
            <button
              type="button"
              onClick={() => act("complete", selectedWinner ?? undefined)}
              disabled={!!actionBusy}
              style={primaryBtn}
            >
              {actionBusy === "complete" ? "…" : t("app.abTests.actComplete")}
            </button>
          )}
          {status === "COMPLETED" && test.winnerVariantId && (
            <button
              type="button"
              onClick={() => act("promote")}
              disabled={!!actionBusy}
              style={primaryBtn}
            >
              {actionBusy === "promote" ? "…" : t("app.abTests.actPromote")}
            </button>
          )}
        </div>
      </div>

      {/* Variant grid */}
      <section style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16 }}>
        {test.variants.map((variant) => {
          const r = results?.variants.find((rv) => rv.variantId === variant.id);
          const isWinner = test.winnerVariantId === variant.id || r?.isWinner;
          const isSelectedWinner = selectedWinner === variant.id;
          return (
            <article
              key={variant.id}
              style={{
                border: isWinner
                  ? "1px solid rgba(52,211,153,0.4)"
                  : "1px solid var(--bv-glass-border, rgba(255,255,255,0.10))",
                borderRadius: 14,
                padding: 16,
                background: "rgba(255,255,255,0.02)",
              }}
              aria-labelledby={`variant-${variant.id}-name`}
            >
              <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 id={`variant-${variant.id}-name`} style={{ fontSize: 16, fontWeight: 600 }}>
                  {variant.name}
                </h3>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--color-outline)" }}>
                    {variant.weight}% {t("app.abTests.traffic")}
                  </span>
                  {isWinner && (
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "rgba(52,211,153,0.12)",
                        color: "#34d399",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                      }}
                    >
                      {t("app.abTests.winner")}
                    </span>
                  )}
                </div>
              </header>

              {/* Config preview */}
              <div style={{ marginTop: 10, padding: 10, background: "rgba(0,0,0,0.30)", borderRadius: 8, fontFamily: "monospace", fontSize: 11, color: "var(--color-on-surface-variant)", whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto" }}>
                {JSON.stringify(variant.config, null, 2)}
              </div>

              {/* Metrics */}
              {r && r.totalMetricRecords > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "var(--color-outline)", marginBottom: 6 }}>
                    {t("app.abTests.metricsHeader", { count: r.totalMetricRecords })}
                  </div>
                  {Object.entries(r.metrics).map(([metricName, cell]) => {
                    const max = metricMaxes.get(metricName) ?? 0;
                    const fill = max > 0 ? Math.min(100, (Math.abs(cell.avg) / max) * 100) : 0;
                    return (
                      <div key={metricName} style={{ marginBottom: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                          <span>{metricName}</span>
                          <span style={{ color: "var(--color-on-surface)" }}>
                            {fmt(cell.avg)} ±{fmt(cell.stdDev)} <span style={{ color: "var(--color-outline)" }}>(n={cell.count})</span>
                          </span>
                        </div>
                        <div style={{ height: 4, background: "rgba(255,255,255,0.04)", borderRadius: 999, marginTop: 3 }}>
                          <div
                            style={{
                              width: `${fill}%`,
                              height: "100%",
                              background: isWinner ? "#34d399" : "#00d1ff",
                              borderRadius: 999,
                              transition: "width 300ms ease-out",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pick winner (active states only) */}
              {(status === "RUNNING" || status === "PAUSED") && (
                <button
                  type="button"
                  onClick={() => setSelectedWinner(isSelectedWinner ? null : variant.id)}
                  style={{
                    marginTop: 12,
                    width: "100%",
                    padding: "6px 0",
                    background: isSelectedWinner ? "rgba(52,211,153,0.16)" : "transparent",
                    color: isSelectedWinner ? "#34d399" : "var(--color-on-surface-variant)",
                    border: `1px solid ${isSelectedWinner ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.10)"}`,
                    borderRadius: 8,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {isSelectedWinner ? t("app.abTests.selectedAsWinner") : t("app.abTests.selectAsWinner")}
                </button>
              )}
            </article>
          );
        })}
      </section>

      {/* Improvement summary */}
      {results && Object.keys(results.comparison).length > 0 && (
        <section style={{ marginTop: 24, padding: 16, border: "1px solid var(--bv-glass-border, rgba(255,255,255,0.08))", borderRadius: 14 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
            {t("app.abTests.improvementSummary")}
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {Object.entries(results.comparison).map(([metric, cmp]) => (
              <div key={metric} style={{ padding: 10, background: "rgba(255,255,255,0.02)", borderRadius: 10 }}>
                <div style={{ fontSize: 11, color: "var(--color-outline)" }}>{metric}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#34d399", marginTop: 2 }}>
                  {cmp.improvement} {t("app.abTests.better")}
                </div>
                <div style={{ fontSize: 11, color: "var(--color-on-surface-variant)", marginTop: 2 }}>
                  {cmp.bestVariant} {fmt(cmp.bestAvg)} <span style={{ color: "var(--color-outline)" }}>vs</span> {cmp.worstVariant} {fmt(cmp.worstAvg)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--color-primary-container, #00d1ff)",
  color: "#000",
  border: "none",
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 36,
};
const ghostBtn: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: "var(--color-on-surface-variant)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 10,
  fontSize: 12,
  cursor: "pointer",
  minHeight: 36,
};
