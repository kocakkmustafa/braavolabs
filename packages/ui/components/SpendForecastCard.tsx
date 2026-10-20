"use client";
import { useLocalizedFailure } from "../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


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
 *   under_budget    green bar at projected / budget
 *   nearing_budget  amber bar, "{n}% of budget projected" caption
 *   over_budget     red bar at 100%, banner: "Auto-spend gating active.
 *                    Approvals require manual override."
 *
 * The 14-day sparkline at the bottom uses inline SVG (no chart lib;
 * matches the rest of the dashboard) — quadratic smoothing on a
 * normalised path. Hover the bars to see per-day cost.
 *
 * Re-fetches every 60s with `useFocusPoll`-style logic (a plain
 * setInterval gated on document.visibilityState — the polling helper
 * lives in mobile right now).
 */

import { useCallback, useEffect, useState, useId, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency, formatDateTime, formatNumber } from "../i18n/locales";
import { api } from "../lib/api";
import { useAppStore, captureAuthSession, isAuthSessionCurrent } from "../lib/store";

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

const STATUS_COLOR: Record<Forecast["status"], string> = {
  no_budget: "var(--color-on-surface-variant)",
  under_budget: "#34d399",
  nearing_budget: "#fbbf24",
  over_budget: "#f87171",
};

function fmtUsd(n: number, locale: string): string {
  const digits = n >= 1000 ? 0 : n >= 10 ? 2 : 4;
  return formatCurrency(n, "USD", locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function Sparkline({ data, color }: { data: Forecast["sparkline"]; color: string }) {
  const uiText = useLegacyTranslations("uiCopy");
  const locale = useLocale();
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
    <svg width={width} height={height} aria-label={uiText("maa31d4cc5e14")} role="img">
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
          <title>{`${formatDateTime(p.raw.date, locale, { timeZone: "UTC", dateStyle: "medium" })}: ${fmtUsd(p.raw.costUsd, locale)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

export default function SpendForecastCard() {
  const revision = useAppStore(s => s.sessionRevision);
  return <ForecastContent key={revision} />;
}

function ForecastContent() {
  const owner = useRef(captureAuthSession());
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const current = () => mounted.current && isAuthSessionCurrent(owner.current);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const describeFailure = useLocalizedFailure();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const locale = useLocale();
  const budgetInputId = useId();
  const token = useAppStore((s) => s.token);
  const t = useTranslations("app.dashboard.forecast");
  const [data, setData] = useState<Forecast | null>(null);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !current()) return;
    const request = ++loadRequest.current;
    try {
      const f = (await api.spendForecast(token)) as Forecast;
      if (!current() || request !== loadRequest.current) return;
      setData(f);
      setError(null);
      setBudgetInput(f.budgetUsd != null ? String(f.budgetUsd) : "");
    } catch (err) {
      if (current() && request === loadRequest.current) setError(describeFailure(err, runtimeCopy("ma682e26e6a31")));
    }
  }, [token, locale]);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function saveBudget(clear: boolean) {
    if (!token || !current()) return;
    setSaving(true);
    try {
      const value = clear ? null : Number(budgetInput);
      if (!clear && (isNaN(value as number) || (value as number) <= 0)) {
        setError(t("invalid"));
        setSaving(false);
        return;
      }
      await api.setMonthlyBudget(token, value);
      if (!current()) return;
      setEditingBudget(false);
      setError(null);
      await load();
    } catch (err) {
      if (current()) setError(describeFailure(err, runtimeCopy("m05d6a641b6be")));
    } finally {
      if (current()) setSaving(false);
    }
  }

  if (!data) {
    return (
      <div className="bv-tile" style={{ minHeight: 220 }}>
        <div className="bv-tile-title">{t("title")}</div>
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
    <div className="bv-tile" style={{ minHeight: 220 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="bv-tile-title">{t("title")}</div>
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

      {error && !editingBudget && <p role="alert" style={{ marginTop: 10, color: "var(--color-error)", fontSize: 13 }}>{error}</p>}

      {/* Big number — current spend */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif" }}>
          {fmtUsd(data.currentSpendUsd, locale)}
        </div>
        <div style={{ fontSize: 11, color: "var(--color-outline)", marginTop: 4 }}>
          {t("spent_so_far", { days: data.daysElapsed })}
        </div>
      </div>

      {/* Projection line */}
      <div style={{ marginTop: 14, fontSize: 12, color: "var(--color-on-surface-variant)" }}>
        {t("projected_to_eom", {
          amount: fmtUsd(data.projectedMonthEndUsd, locale),
          daily: fmtUsd(data.dailyAverageUsd, locale),
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
            aria-valuenow={barFill}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("title")}
            aria-valuetext={t("budget_bar_label", { pct: projectedPct ?? 0 })}
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
            <span style={{ color: "var(--color-outline)" }}>{fmtUsd(data.budgetUsd, locale)}</span>
          </div>
          {data.status === "over_budget" && (
            <div
              role="alert"
              style={{
                marginTop: 8,
                padding: "8px 10px",
                background: "rgba(248,113,113,0.10)",
                border: "1px solid rgba(248,113,113,0.25)",
                borderRadius: 8,
                fontSize: 11,
                color: "var(--color-error)",
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
          <label htmlFor={budgetInputId} style={{ fontSize: 11, color: "var(--color-outline)", display: "block" }}>
            {t("monthly_budget_usd")}
          </label>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input
              id={budgetInputId}
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
                  color: "var(--color-error)",
                  border: "1px solid rgba(248,113,113,0.25)",
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
            <div style={{ fontSize: 11, color: "var(--color-error)", marginTop: 6 }}>{error}</div>
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
                {fmtUsd(row.costUsd, locale)} · {formatNumber(row.callCount, locale)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
