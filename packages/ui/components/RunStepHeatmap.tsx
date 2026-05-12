"use client";

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

function parseCost(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : 0;
}

function deriveDurationMs(s: HeatmapStep): number {
  if (typeof s.durationMs === "number") return s.durationMs;
  if (s.startedAt && s.completedAt) {
    const ms = new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime();
    return ms > 0 ? ms : 0;
  }
  return 0;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(0);
  return `${m}m ${rem}s`;
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
  const [metric, setMetric] = useState<Metric>("cost");
  const [hoverId, setHoverId] = useState<string | null>(null);

  const enriched = useMemo(() => {
    const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
    let totalCostFromSteps = 0;
    let totalDuration = 0;
    let maxCost = 0;
    let maxDuration = 0;

    for (const s of ordered) {
      const cost = parseCost(s.costUsd);
      const duration = deriveDurationMs(s);
      totalCostFromSteps += cost;
      totalDuration += duration;
      if (cost > maxCost) maxCost = cost;
      if (duration > maxDuration) maxDuration = duration;
    }

    const enrichedSteps = ordered.map((s) => {
      const cost = parseCost(s.costUsd);
      const duration = deriveDurationMs(s);
      return {
        ...s,
        cost,
        duration,
        costIntensity: maxCost > 0 ? cost / maxCost : 0,
        durationIntensity: maxDuration > 0 ? duration / maxDuration : 0,
      };
    });

    return {
      steps: enrichedSteps,
      totalCostFromSteps,
      totalDuration,
      maxCost,
      maxDuration,
    };
  }, [steps]);

  if (enriched.steps.length === 0) {
    return null;
  }

  const headerCost = totalCostUsd ?? enriched.totalCostFromSteps;
  const peak = enriched.steps.reduce((acc, s) =>
    (metric === "cost" ? s.cost : s.duration) >
    (metric === "cost" ? acc.cost : acc.duration)
      ? s
      : acc,
  );

  return (
    <section
      className={`bv-glass bv-panel ${className}`}
      aria-label="Run step cost heatmap"
    >
      <header className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="bv-micro" style={{ marginBottom: 4 }}>
            Step heatmap · {enriched.steps.length} step{enriched.steps.length === 1 ? "" : "s"}
          </div>
          <h3 className="text-base font-semibold" style={{ color: "#e1e2eb", margin: 0 }}>
            Where the spend went
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="bv-micro" style={{ opacity: 0.7 }}>
            Total: <span className="bv-mono">{formatCost(headerCost)}</span> · {formatDuration(enriched.totalDuration)}
          </span>
          <div
            role="group"
            aria-label="Color metric"
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
                color: metric === "cost" ? "#080810" : "#a4e6ff",
                background: metric === "cost" ? "#00d1ff" : "transparent",
                borderRadius: 999,
              }}
            >
              Cost
            </button>
            <button
              type="button"
              onClick={() => setMetric("duration")}
              className="px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                color: metric === "duration" ? "#080810" : "#a4e6ff",
                background: metric === "duration" ? "#00d1ff" : "transparent",
                borderRadius: 999,
              }}
            >
              Duration
            </button>
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
            const isPeak = s.id === peak.id;
            return (
              <button
                type="button"
                key={s.id}
                role="listitem"
                aria-label={`Step ${s.stepIndex + 1} ${s.name ?? s.agentRole ?? ""} cost ${formatCost(s.cost)} duration ${formatDuration(s.duration)}`}
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
                    style={{ fontSize: 9, color: "#a4e6ff" }}
                  >
                    peak
                  </span>
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
                  color: "#e1e2eb",
                }}
              >
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="font-semibold">
                    Step {s.stepIndex + 1}: {s.name ?? s.agentRole ?? "Unnamed"}
                  </span>
                  <span
                    className="font-mono"
                    style={{ color: "#a4e6ff", fontSize: 11 }}
                  >
                    {(s.status ?? "pending").toLowerCase()}
                  </span>
                </div>
                <div
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono"
                  style={{ fontSize: 11, color: "rgba(225,226,235,0.78)" }}
                >
                  <span>cost: {formatCost(s.cost)}</span>
                  <span>duration: {formatDuration(s.duration)}</span>
                  <span>
                    tools: {s.toolCalls?.length ?? 0}
                  </span>
                  {s.agentRole && <span>agent: {s.agentRole}</span>}
                </div>
                {onSelectStep && (
                  <div className="mt-1 text-[10.5px]" style={{ color: "rgba(164,230,255,0.75)" }}>
                    Click to jump to this step ↓
                  </div>
                )}
              </div>
            );
          })()}
      </div>

      {/* Legend */}
      <div
        className="mt-3 flex items-center justify-between text-[10.5px]"
        style={{ color: "rgba(225,226,235,0.55)" }}
      >
        <span>← step 1</span>
        <div className="flex items-center gap-2">
          <span>low</span>
          <div
            className="h-1.5 w-32 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, rgba(0,209,255,0.10) 0%, rgba(0,209,255,0.65) 100%)",
            }}
          />
          <span>high {metric}</span>
        </div>
        <span>step {enriched.steps.length} →</span>
      </div>
    </section>
  );
}

export default RunStepHeatmap;
