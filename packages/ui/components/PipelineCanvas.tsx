"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/**
 * Interactive DAG canvas for a pipeline's topology (Pillar 1, "build
 * automations visually" — the richer view on top of the dep-free static
 * PipelineGraph).
 *
 * Scope: a READ-ONLY-but-interactive map — pan / zoom / minimap / draggable
 * nodes for exploration, animated stage-to-stage edges. It is correct by
 * construction (no node-position → order persistence, so nothing can be saved
 * wrong); structural editing stays in the parallel-aware step editor. Loaded
 * via `next/dynamic({ ssr: false })` by the page so React Flow's DOM-measuring
 * hooks never run during prerender.
 */

interface CanvasStep {
  name: string;
  agentRole: string;
}
interface CanvasStage {
  order: number;
  steps: CanvasStep[];
}

const COL = 240; // px between stage columns
const ROW = 96; // px between stacked parallel nodes

export function PipelineCanvas({
  stages,
  isHierarchical,
  maxDelegationDepth,
}: {
  stages: CanvasStage[];
  isHierarchical: boolean;
  maxDelegationDepth?: number;
}) {
  const t = useTranslations();

  const { nodes, edges } = useMemo(() => {
    if (isHierarchical) {
      const ns: Node[] = [
        {
          id: "manager",
          position: { x: 0, y: 0 },
          data: { label: t("app.pipelineDetail.typeHierarchical") },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          style: managerStyle,
        },
      ];
      return { nodes: ns, edges: [] as Edge[] };
    }

    const ns: Node[] = [];
    const es: Edge[] = [];
    stages.forEach((stage, si) => {
      const colY0 = -((stage.steps.length - 1) * ROW) / 2;
      stage.steps.forEach((s, ri) => {
        const id = `${si}-${ri}`;
        ns.push({
          id,
          position: { x: si * COL, y: colY0 + ri * ROW },
          data: {
            label: (
              <div style={{ textAlign: "start", lineHeight: 1.25 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-on-surface)" }}>{s.name}</div>
                <div style={{ fontSize: 10, color: "var(--color-info)", fontFamily: "monospace" }}>{s.agentRole}</div>
                <div style={{ fontSize: 9, color: "var(--color-on-surface-variant)", marginTop: 2 }}>
                  {t("app.pipelineDetail.stagePill", { n: si + 1 })}
                </div>
              </div>
            ),
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          style: nodeStyle,
        });
      });
      // Fan edges from every node in this stage to every node in the next.
      if (si < stages.length - 1) {
        const next = stages[si + 1];
        stage.steps.forEach((_, ri) => {
          next.steps.forEach((__, rj) => {
            es.push({
              id: `e-${si}-${ri}__${si + 1}-${rj}`,
              source: `${si}-${ri}`,
              target: `${si + 1}-${rj}`,
              animated: true,
              style: { stroke: "rgba(0,209,255,0.35)" },
            });
          });
        });
      }
    });
    return { nodes: ns, edges: es };
  }, [stages, isHierarchical, t]);

  if (!isHierarchical && stages.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "var(--color-outline)", fontSize: 13 }}>
        {t("app.pipelineDetail.noSteps")}
      </div>
    );
  }

  return (
    <div style={{ height: 420, width: "100%", borderRadius: 12, overflow: "hidden", border: "1px solid var(--bv-glass-border)" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background color="rgba(255,255,255,0.06)" gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ background: "var(--color-surface-container-low)" }} maskColor="rgba(0,0,0,0.5)" nodeColor="#00d1ff" />
      </ReactFlow>
      {isHierarchical && (
        <p style={{ fontSize: 11, color: "var(--color-on-surface-variant)", padding: "8px 12px", margin: 0 }}>
          {t.rich("app.pipelineDetail.hierarchicalNote", {
            depth: maxDelegationDepth ?? 3,
            b: (c) => <strong>{c}</strong>,
          })}
        </p>
      )}
    </div>
  );
}

const nodeStyle = {
  background: "var(--color-surface-container-low)",
  border: "1px solid rgba(0,209,255,0.25)",
  borderRadius: 12,
  padding: "8px 12px",
  width: 180,
} as const;

const managerStyle = {
  background: "rgba(109,17,173,0.18)",
  border: "1px solid rgba(224,182,255,0.35)",
  borderRadius: 12,
  padding: "10px 14px",
  color: "var(--color-accent)",
  fontWeight: 700,
} as const;
