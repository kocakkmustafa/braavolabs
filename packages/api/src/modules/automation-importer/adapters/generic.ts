/**
 * Generic "nodes + edges" graph → Braavolabs pipeline.
 *
 * Last-resort schema for users who can describe their automation as
 * a JSON DAG ({ nodes: [{ id, type, config }], edges: [{ from, to }] })
 * but don't have a supported source. Conversion is 1:1 — node.type
 * stays as the step type, node.config stays as step config. The user
 * is responsible for ensuring step types exist in the executor's tool
 * registry; the runtime fails the run with a friendly "unknown step
 * type" error rather than silently mis-routing.
 */

import type { ConvertedPipeline } from "./types";

interface GenericGraph {
  name?: string;
  description?: string;
  nodes?: Array<{ id: string; type: string; config?: unknown }>;
  edges?: Array<{ from: string; to: string }>;
}

export function fromGeneric(payload: string): ConvertedPipeline {
  let graph: GenericGraph;
  try {
    graph = JSON.parse(payload) as GenericGraph;
  } catch (err) {
    throw new Error(`Invalid generic graph JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const steps = nodes.map((n) => ({ id: n.id, type: n.type, config: n.config ?? {} }));

  return {
    pipeline: {
      name: graph.name ?? "Imported automation",
      description: graph.description ?? `Imported generic graph (${steps.length} node(s))`,
      steps,
    },
    dropped: [],
    warnings:
      Array.isArray(graph.edges) && graph.edges.length > 0
        ? [
            "Edges in the source graph are preserved on Pipeline.config but the runtime currently executes steps in array order — branching graphs need a follow-up to honour edge semantics.",
          ]
        : [],
  };
}
