"use client";
import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


/**
 * RunStepHeatmap — extends the cost panel with a live per-step heatmap.
 *
 * Renders every step in a run as a single cell in a horizontal grid.
 * Cell width scales with duration; cell color intensity scales with
 * either cost or duration (toggle). Hovering shows the exact spend +
 * tool call count; clicking jumps to that step in the audit trail.
 *
 * Why this exists: the transparent-cost moat that Braavolabs ships is
 * weakened if the user has to scroll through 30 steps to find the
 * money-burner. This is the "at-a-glance" surface — the most expensive
 * step lights up.
 *
 * Self-contained: takes a `steps` array (already loaded by the run
 * detail page) and an `onSelectStep` callback. No additional fetch.
 */
import { useMemo, useState } from "react";
import { useDisplayFormats } from "../lib/useDisplayFormats";

export interface HeatmapStep {
  id: string;
  stepIndex: number;
  agentRole?: string;
  name?: string;
  status?: string;
  costUsd?: number | string | null;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  toolCalls?: Array<{ id: string }>;
}

interface RunStepHeatmapProps {
  steps: HeatmapStep[];
  totalCostUsd?: number;
  onSelectStep?: (stepId: string) => void;
  className?: string;
}

type Metric = "cost" | "duration";

const STATUS_BORDER: Record<string, string> = {
  completed: "rgba(52,211,153,0.45)",
  succeeded: "rgba(52,211,153,0.45)",
  running: "rgba(0,209,255,0.55)",
  failed: "rgba(239,68,68,0.55)",
  cancelled: "rgba(133,147,153,0.45)",
  paused: "rgba(251,191,36,0.45)",
  waiting_approval: "rgba(251,146,60,0.55)",
  pending: "rgba(133,147,153,0.30)",
  rolled_back: "rgba(168,85,247,0.45)",
};

function knownCost(value: number | string | null | undefined): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === null || value === undefined || value === "" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function knownDuration(s: HeatmapStep): number | null {
  if (typeof s.durationMs === "number") return Number.isFinite(s.durationMs) && s.durationMs >= 0 ? s.durationMs : null;
  if (s.startedAt && s.completedAt) {
    const ms = new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  return null;
}

/**
 * Mix the brand cyan with white based on `intensity ∈ [0, 1]`.
 * 0 → faint surface, 1 → saturated brand color. Linear in HSL space
 * via a CSS gradient stop synthesis.
 */
function heatColor(intensity: number): string {
  const i = Math.max(0, Math.min(1, intensity));
  const a = 0.10 + i * 0.55;
  return `rgba(0,209,255,${a.toFixed(3)})`;
}

export function RunStepHeatmap({
  steps,
  totalCostUsd,
  onSelectStep,
  className = "",
}: RunStepHeatmapProps) {
  const displayFormat = useDisplayFormats();
  const stateCopy = useLegacyTranslations("surface.states");
  const stateLabel = (value?: string) => { const state = value?.toLowerCase() === "succeeded" ? "completed" : value?.toLowerCase(); return stateCopy(["running", "completed", "paused", "failed", "cancelled", "waiting_approval", "pending", "queued"].includes(state ?? "") ? state! : "unknown"); };
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  const [metric, setMetric] = useState<Metric>("cost");
  const [hoverId, setHoverId] = useState<string | null>(null);

  const enriched = useMemo(() => {
    const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
    let totalCostFromSteps = 0;
    let totalDuration = 0;
    let maxCost = 0;
    let maxDuration = 0;

    for (const s of ordered) {
      const cost = (knownCost(s.costUsd) ?? 0);
      const duration = (knownDuration(s) ?? 0);
      totalCostFromSteps += cost;
      totalDuration += duration;
      if (cost > maxCost) maxCost = cost;
      if (duration > maxDuration) maxDuration = duration;
    }

    const enrichedSteps = ordered.map((s) => {
      const cost = (knownCost(s.costUsd) ?? 0);
      const duration = (knownDuration(s) ?? 0);
      return {
        ...s,
        cost,
        duration,
        costKnown: knownCost(s.costUsd) !== null,
        durationKnown: knownDuration(s) !== null,
        costIntensity: maxCost > 0 ? cost / maxCost : 0,
        durationIntensity: maxDuration > 0 ? duration / maxDuration : 0,
      };
    });

    return {
      steps: enrichedSteps,
      totalCostFromSteps,
      allCostKnown: ordered.every(s => knownCost(s.costUsd) !== null),
      allDurationKnown: ordered.every(s => knownDuration(s) !== null),
      totalDuration,
      maxCost,
      maxDuration,
    };
  }, [steps]);

  if (enriched.steps.length === 0) {
    return null;
  }

  const headerCost = knownCost(totalCostUsd) ?? (enriched.allCostKnown ? enriched.totalCostFromSteps : null);
  const measuredSteps = enriched.steps.filter(s => metric === "cost" ? s.costKnown : s.durationKnown);
  const peak = measuredSteps.length ? measuredSteps.reduce((acc, s) =>
    (metric === "cost" ? s.cost : s.duration) >
    (metric === "cost" ? acc.cost : acc.duration)
      ? s
      : acc,
  ) : null;

  return (
    <section
      className={`bv-glass bv-panel ${className}`}
      aria-label={uiText("md09f1084ca66")}
    >
      <header className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="bv-micro" style={{ marginBottom: 4 }}>{uiText("md157b491332a")}{" "}{enriched.steps.length}{" "}{uiText("m4f7017581fe7")}{enriched.steps.length === 1 ? "" : "s"}
          </div>
          <h3 className="text-base font-semibold" style={{ color: "var(--color-on-surface)", margin: 0 }}>{uiText("m1bfba96b1e61")}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="bv-micro" style={{ opacity: 0.7 }}>{uiText("m454e25940ea0")}{" "}<span className="bv-mono">{displayFormat.usd(headerCost)}</span> · {displayFormat.duration(enriched.allDurationKnown ? enriched.totalDuration : null)}
          </span>
          <div
            role="group"
            aria-label={uiText("m926c7bc3cb4e")}
            className="inline-flex rounded-full border"
            style={{
              borderColor: "rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <button
              type="button"
              onClick={() => setMetric("cost")}
              className="px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                color: metric === "cost" ? "#080810" : "var(--color-info)",
                background: metric === "cost" ? "#00d1ff" : "transparent",
                borderRadius: 999,
              }}
            >{uiText("m7962e0ef9564")}</button>
            <button
              type="button"
              onClick={() => setMetric("duration")}
              className="px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                color: metric === "duration" ? "#080810" : "var(--color-info)",
                background: metric === "duration" ? "#00d1ff" : "transparent",
                borderRadius: 999,
              }}
            >{uiText("maca226308ff4")}</button>
          </div>
        </div>
      </header>

      {/* Heatmap row */}
      <div className="relative">
        <div
          role="list"
          className="flex w-full gap-[3px] rounded-lg overflow-hidden"
          style={{ background: "rgba(255,255,255,0.03)", padding: 2 }}
        >
          {enriched.steps.map((s) => {
            const intensity = metric === "cost" ? s.costIntensity : s.durationIntensity;
            const flexBasis = Math.max(1, s.duration);
            const isPeak = s.id === peak?.id;
            return (
              <button
                type="button"
                key={s.id}
                role="listitem"
                aria-label={runtimeCopy("m6c6656e064e0", { value0: s.stepIndex + 1, value1: s.name ?? s.agentRole ?? "", value2: displayFormat.usd(s.costKnown ? s.cost : null), value3: displayFormat.duration(s.durationKnown ? s.duration : null) })}
                onMouseEnter={() => setHoverId(s.id)}
                onMouseLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(s.id)}
                onBlur={() => setHoverId(null)}
                onClick={() => onSelectStep?.(s.id)}
                className="group relative h-12 min-w-[14px] cursor-pointer rounded-md transition-transform hover:scale-[1.03] focus:scale-[1.03] focus:outline-none"
                style={{
                  flex: `${flexBasis} 1 0`,
                  background: heatColor(intensity),
                  border: `1px solid ${STATUS_BORDER[(s.status ?? "pending").toLowerCase()] ?? STATUS_BORDER.pending}`,
                  boxShadow: isPeak ? "0 0 0 2px rgba(0,209,255,0.35)" : undefined,
                }}
              >
                <span
                  className="absolute inset-x-0 top-1 text-center font-mono"
                  style={{ fontSize: 9, color: "rgba(255,255,255,0.55)" }}
                >
                  {s.stepIndex + 1}
                </span>
                {isPeak && (
                  <span
                    className="absolute inset-x-0 bottom-1 text-center font-mono"
                    style={{ fontSize: 9, color: "var(--color-info)" }}
                  >{uiText("m82891b0c7c6e")}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Hover panel */}
        {hoverId &&
          (() => {
            const s = enriched.steps.find((x) => x.id === hoverId);
            if (!s) return null;
            return (
              <div
                className="mt-3 rounded-lg border px-3 py-2 text-[12px]"
                style={{
                  borderColor: "rgba(0,209,255,0.20)",
                  background: "rgba(0,209,255,0.05)",
                  color: "var(--color-on-surface)",
                }}
              >
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="font-semibold">{uiText("mcff790642459")}{" "}{s.stepIndex + 1}: {s.name ?? s.agentRole ??uiText("m91c4b9a9a975")}
                  </span>
                  <span
                    className="font-mono"
                    style={{ color: "var(--color-info)", fontSize: 11 }}
                  >
                    {stateLabel(s.status)}
                  </span>
                </div>
                <div
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono"
                  style={{ fontSize: 11, color: "var(--color-on-surface-variant)" }}
                >
                  <span>{uiText("mdde548bb2e5e")}{" "}{displayFormat.usd(s.costKnown ? s.cost : null)}</span>
                  <span>{uiText("ma4f2af79632e")}{" "}{displayFormat.duration(s.durationKnown ? s.duration : null)}</span>
                  <span>{uiText("m946e0fce8ef2")}{" "}{displayFormat.number(s.toolCalls?.length)}
                  </span>
                  {s.agentRole && <span>{uiText("m42e92aa8ff4c")}{" "}{s.agentRole}</span>}
                </div>
                {onSelectStep && (
                  <div className="mt-1 text-[10.5px]" style={{ color: "var(--color-info)" }}>{uiText("m71160bc18aec")}</div>
                )}
              </div>
            );
          })()}
      </div>

      {/* Legend */}
      <div
        className="mt-3 flex items-center justify-between text-[10.5px]"
        style={{ color: "var(--color-outline)" }}
      >
        <span>{uiText("m85e4a839e0c6")}</span>
        <div className="flex items-center gap-2">
          <span>{uiText("m8a413bb66127")}</span>
          <div
            className="h-1.5 w-32 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, rgba(0,209,255,0.10) 0%, rgba(0,209,255,0.65) 100%)",
            }}
          />
          <span>{uiText("m66114b892e7f")}{" "}{metric}</span>
        </div>
        <span>{uiText("m4f7017581fe7")}{" "}{enriched.steps.length} →</span>
      </div>
    </section>
  );
}

export default RunStepHeatmap;
