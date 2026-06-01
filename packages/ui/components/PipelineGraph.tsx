"use client";

import { Fragment } from "react";
import { useTranslations } from "next-intl";

/**
 * Read-only DAG view of a pipeline's topology — the "build automations
 * visually" surface (Pillar 1). Renders the same `stages` the list view
 * computes (steps grouped by `order`; same order ⇒ a parallel stage) as a
 * left-to-right flow of stage columns with connectors between them.
 *
 * Dependency-free on purpose: the topology is a simple linear chain of stages,
 * so a fl/SVG layout matches the bv-* design system, adds zero bundle weight,
 * and always builds. Interactive node drag/connect (React Flow) is a follow-on
 * on top of the existing step editor.
 */

interface GraphStep {
  name: string;
  agentRole: string;
}
interface GraphStage {
  order: number;
  steps: GraphStep[];
}

export function PipelineGraph({
  stages,
  isHierarchical,
  maxDelegationDepth,
}: {
  stages: GraphStage[];
  isHierarchical: boolean;
  maxDelegationDepth?: number;
}) {
  const t = useTranslations();

  if (isHierarchical) {
    return (
      <div style={{ padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <Node title={t("app.pipelineDetail.typeHierarchical")} subtitle={t("app.pipelineDetail.managerDelegated")} accent="#e0b6ff" icon="hub" />
        <span className="material-symbols-outlined" style={{ color: "#3c494e", fontSize: 18 }}>more_vert</span>
        <div style={{ fontSize: 12, color: "var(--color-on-surface-variant)", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
          {t.rich("app.pipelineDetail.hierarchicalNote", {
            depth: maxDelegationDepth ?? 3,
            b: (c) => <strong>{c}</strong>,
          })}
        </div>
      </div>
    );
  }

  if (stages.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
        {t("app.pipelineDetail.noSteps")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 0, overflowX: "auto", padding: "12px 4px" }}>
      {stages.map((stage, i) => {
        const parallel = stage.steps.length > 1;
        return (
          <Fragment key={stage.order}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 180, flexShrink: 0 }}>
              <span className="bv-pill bv-pill-muted" style={{ alignSelf: "flex-start" }}>
                {t("app.pipelineDetail.stagePill", { n: i + 1 })}
              </span>
              {stage.steps.map((s, j) => (
                <Node key={j} title={s.name} subtitle={s.agentRole} accent="#00d1ff" icon="smart_toy" mono />
              ))}
              {parallel && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#a4e6ff", alignSelf: "flex-start" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>call_split</span>
                  {t("app.pipelineDetail.parallelCount", { n: stage.steps.length })}
                </span>
              )}
            </div>
            {i < stages.length - 1 && (
              <div style={{ display: "flex", alignItems: "center", padding: "0 6px", flexShrink: 0 }} aria-hidden>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#3c494e" }}>arrow_forward</span>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function Node({
  title,
  subtitle,
  accent,
  icon,
  mono,
}: {
  title: string;
  subtitle?: string;
  accent: string;
  icon: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${accent}33`,
        boxShadow: `0 0 0 1px ${accent}11`,
      }}
    >
      <span
        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: `${accent}14`, border: `1px solid ${accent}26` }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 15, color: accent }}>{icon}</span>
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: "var(--color-on-surface)", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130 }}>
          {title}
        </div>
        {subtitle && (
          <div className={mono ? "bv-mono" : undefined} style={{ fontSize: 11, color: "var(--color-outline)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130 }}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
