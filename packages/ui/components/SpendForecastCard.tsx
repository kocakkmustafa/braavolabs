"use client";

/**
 * SpendForecastCard — month-end spend projection + budget bar.
 *
 * Renders the response from GET /api/v1/billing/forecast as a single
 * dashboard tile. Three states:
 *
 *   no_budget       informational: shows spent so far + projected,
 *                    invites the user to set a budget via the inline
 *                    "Set budget" button (opens the budget editor
 *                    inside this card; no separate page)
 *   under_budget    arc-blue bar at projected / budget
 *   nearing_budget  ember/warn bar, "{n}% of budget projected" caption
 *   over_budget     molten-red bar at 100%, banner: "Auto-spend gating
 *                    active. Approvals require manual override."
 *
 * The 14-day sparkline at the bottom uses inline SVG (no chart lib;
 * matches the rest of the dashboard) — quadratic smoothing on a
 * normalised path. Hover the bars to see per-day cost.
 *
 * Re-fetches every 60s with `useFocusPoll`-style logic (a plain
 * setInterval gated on document.visibilityState — the polling helper
 * lives in mobile right now).
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../lib/api";
import { useAppStore } from "../lib/store";

type Forecast = {
  periodStart: string;
  periodEnd: string;
  currentSpendUsd: number;
  dailyAverageUsd: number;
  projectedMonthEndUsd: number;
  daysElapsed: number;
  daysRemaining: number;
  budgetUsd: number | null;
  status: "no_budget" | "under_budget" | "nearing_budget" | "over_budget";
  sparkline: Array<{ date: string; costUsd: number }>;
  topToolsByCost: Array<{ toolName: string; costUsd: number; callCount: number }>;
};

// Forge palette — no green anywhere in the product (see forge-hero.module.css
// / app/globals.css bv-* tokens): "healthy" reads as arc-blue instead of the
// traditional green, "nearing" reuses the same ember/warn tone the rest of
// the dashboard already uses for running/caution state, "over" is molten red
// (matches --bv-status-failed exactly, same as .bv-pill-red / risk severity).
const STATUS_COLOR: Record<Forecast["status"], string> = {
  no_budget: "#859399",
  under_budget: "var(--bv-cobalt-glow)",
  nearing_budget: "var(--bv-status-running)",
  over_budget: "var(--bv-status-failed)",
};

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function Sparkline({ data, color }: { data: Forecast["sparkline"]; color: string }) {
  const max = Math.max(0.0001, ...data.map((d) => d.costUsd));
  const width = 240;
  const height = 48;
  const stepX = width / Math.max(1, data.length - 1);
  const points = data.map((d, i) => {
    const x = i * stepX;
    const y = height - (d.costUsd / max) * (height - 4) - 2;
    return { x, y, raw: d };
  });
  // Quadratic smoothing — midpoint anchor between consecutive points.
  const path = points.reduce((acc, p, i) => {
    if (i === 0) return `M ${p.x},${p.y}`;
    const prev = points[i - 1];
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    return `${acc} Q ${prev.x},${prev.y} ${mx},${my} T ${p.x},${p.y}`;
  }, "");

  return (
    <svg width={width} height={height} aria-label="Daily spend, last 14 days" role="img">
      <path d={path} stroke={color} strokeWidth={1.5} fill="none" />
      {/* Hover bars — invisible but pickable */}
      {points.map((p, i) => (
        <rect
          key={i}
          x={p.x - stepX / 2}
          y={0}
          width={stepX}
          height={height}
          fill="transparent"
        >
          <title>{`${p.raw.date}: ${fmtUsd(p.raw.costUsd)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

export default function SpendForecastCard() {
  const token = useAppStore((s) => s.token);
  const t = useTranslations("app.dashboard.forecast");
  const [data, setData] = useState<Forecast | null>(null);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const f = (await api.spendForecast(token)) as Forecast;
      setData(f);
      setError(null);
      setBudgetInput(f.budgetUsd != null ? String(f.budgetUsd) : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load forecast");
    }
  }, [token]);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function saveBudget(clear: boolean) {
    if (!token) return;
    setSaving(true);
    try {
      const value = clear ? null : Number(budgetInput);
      if (!clear && (isNaN(value as number) || (value as number) <= 0)) {
        setError(t("invalid"));
        setSaving(false);
        return;
      }
      await api.setMonthlyBudget(token, value);
      setEditingBudget(false);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return (
      // bv-tile/bv-tile-title were never defined anywhere in globals.css —
      // this card rendered unstyled (no glass surface, no border, no
      // radius) next to bv-glass/bv-panel siblings in the side rail.
      // Swapped to the same primitives the rest of the dashboard uses.
      <div className="bv-glass bv-rim" style={{ minHeight: 220, padding: 18 }}>
        <div className="bv-title">{t("title")}</div>
        <div style={{ color: "var(--color-outline)", fontSize: 13, marginTop: 12 }}>
          {error ?? t("loading")}
        </div>
      </div>
    );
  }

  const color = STATUS_COLOR[data.status];
  const barFill =
    data.budgetUsd && data.projectedMonthEndUsd > 0
      ? Math.min(100, (data.projectedMonthEndUsd / data.budgetUsd) * 100)
      : 0;
  const projectedPct = data.budgetUsd
    ? Math.round((data.projectedMonthEndUsd / data.budgetUsd) * 100)
    : null;

  return (
    <div className="bv-glass bv-rim" style={{ minHeight: 220, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="bv-title">{t("title")}</div>
        {!editingBudget && (
          <button
            type="button"
            onClick={() => setEditingBudget(true)}
            style={{
              background: "transparent",
              color: "var(--color-primary)",
              fontSize: 12,
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {data.budgetUsd != null ? t("edit_budget") : t("set_budget")}
          </button>
        )}
      </div>

      {/* Big number — current spend */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>
          {fmtUsd(data.currentSpendUsd)}
        </div>
        <div style={{ fontSize: 11, color: "var(--color-outline)", marginTop: 4 }}>
          {t("spent_so_far", { days: data.daysElapsed })}
        </div>
      </div>

      {/* Projection line */}
      <div style={{ marginTop: 14, fontSize: 12, color: "var(--color-on-surface-variant)" }}>
        {t("projected_to_eom", {
          amount: fmtUsd(data.projectedMonthEndUsd),
          daily: fmtUsd(data.dailyAverageUsd),
        })}
      </div>

      {/* Budget bar */}
      {data.budgetUsd != null && !editingBudget && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              height: 6,
              background: "rgba(255,255,255,0.06)",
              borderRadius: 999,
              overflow: "hidden",
            }}
            role="progressbar"
            aria-valuenow={projectedPct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("budget_bar_label", { pct: projectedPct ?? 0 })}
          >
            <div
              style={{
                width: `${barFill}%`,
                height: "100%",
                background: color,
                transition: "width 300ms ease-out",
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 6 }}>
            <span style={{ color }}>
              {projectedPct}% {t("of_budget")}
            </span>
            <span style={{ color: "var(--color-outline)" }}>{fmtUsd(data.budgetUsd)}</span>
          </div>
          {data.status === "over_budget" && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                padding: "8px 10px",
                background: "rgba(255,77,77,0.10)",
                border: "1px solid rgba(255,77,77,0.25)",
                borderRadius: 8,
                fontSize: 11,
                color: "var(--bv-status-failed)",
              }}
            >
              {t("over_budget_warning")}
            </div>
          )}
        </div>
      )}

      {/* Inline budget editor */}
      {editingBudget && (
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 11, color: "var(--color-outline)", display: "block" }}>
            {t("monthly_budget_usd")}
          </label>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              autoFocus
              style={{
                flex: 1,
                padding: "6px 10px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 8,
                color: "var(--color-on-surface)",
                fontSize: 13,
                minHeight: 32,
              }}
            />
            <button
              type="button"
              onClick={() => saveBudget(false)}
              disabled={saving}
              style={{
                padding: "6px 12px",
                background: "var(--color-primary-container)",
                color: "#000",
                border: "none",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                minHeight: 32,
              }}
            >
              {t("save")}
            </button>
            {data.budgetUsd != null && (
              <button
                type="button"
                onClick={() => saveBudget(true)}
                disabled={saving}
                style={{
                  padding: "6px 12px",
                  background: "transparent",
                  color: "var(--bv-status-failed)",
                  border: "1px solid rgba(255,77,77,0.25)",
                  borderRadius: 8,
                  fontSize: 12,
                  cursor: "pointer",
                  minHeight: 32,
                }}
              >
                {t("clear")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditingBudget(false)}
              style={{
                padding: "6px 12px",
                background: "transparent",
                color: "var(--color-outline)",
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 8,
                fontSize: 12,
                cursor: "pointer",
                minHeight: 32,
              }}
            >
              {t("cancel")}
            </button>
          </div>
          {error && (
            <div style={{ fontSize: 11, color: "var(--bv-status-failed)", marginTop: 6 }}>{error}</div>
          )}
        </div>
      )}

      {/* Sparkline */}
      <div style={{ marginTop: 16 }}>
        <Sparkline data={data.sparkline} color={color} />
      </div>

      {/* Top tools by cost */}
      {data.topToolsByCost.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "var(--color-outline)", marginBottom: 4 }}>
            {t("top_cost_tools")}
          </div>
          {data.topToolsByCost.map((row) => (
            <div
              key={row.toolName}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                padding: "2px 0",
                color: "var(--color-on-surface-variant)",
              }}
            >
              <span>{row.toolName}</span>
              <span style={{ color: "var(--color-on-surface)" }}>
                {fmtUsd(row.costUsd)} · {row.callCount}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
