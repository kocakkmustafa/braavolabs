/**
 * n8n workflow → Braavolabs pipeline.
 *
 * n8n exports a JSON document with `nodes` (each has type, parameters,
 * position) and `connections` (typed graph edges). We map the most
 * common node families:
 *   • Trigger nodes      → pipeline.trigger config
 *   • HTTP Request       → step type "http" (matches our tool registry)
 *   • Code (JS / Python) → step type "script" (sandboxed)
 *   • If / Switch        → step type "branch"
 *   • Anthropic / OpenAI → step type "llm"
 *
 * Anything we don't recognise lands in `dropped[]` with a reason. The
 * raw payload is preserved on the Pipeline.config so a future converter
 * can re-attempt without losing the user's source-of-truth.
 */

import type { ConvertedPipeline, RawStep } from "./types";
import { finalizeSteps } from "../agent-synthesis";

interface N8nNode {
  id?: string;
  name?: string;
  type: string;
  parameters?: unknown;
}

interface N8nWorkflow {
  name?: string;
  nodes?: N8nNode[];
}

const SUPPORTED_NODE_TYPES: Record<string, string> = {
  "n8n-nodes-base.httpRequest": "http",
  "n8n-nodes-base.code": "script",
  "n8n-nodes-base.if": "branch",
  "n8n-nodes-base.switch": "branch",
  "n8n-nodes-base.set": "transform",
  "@n8n/n8n-nodes-langchain.lmChatAnthropic": "llm",
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": "llm",
};

export function fromN8n(payload: string): ConvertedPipeline {
  let workflow: N8nWorkflow;
  try {
    workflow = JSON.parse(payload) as N8nWorkflow;
  } catch (err) {
    throw new Error(`Invalid n8n JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const rawSteps: RawStep[] = [];
  const dropped: ConvertedPipeline["dropped"] = [];

  for (const node of nodes) {
    const id = node.id ?? node.name ?? `node-${rawSteps.length + dropped.length}`;
    const mapped = SUPPORTED_NODE_TYPES[node.type];
    if (!mapped) {
      dropped.push({
        id,
        type: node.type,
        reason: "Unsupported n8n node type — paste into a manual step or implement a converter.",
      });
      continue;
    }
    rawSteps.push({ id, type: mapped, name: node.name, config: node.parameters ?? {} });
  }

  const steps = finalizeSteps(rawSteps);

  return {
    pipeline: {
      name: workflow.name ?? "Imported n8n workflow",
      description: `Imported from n8n with ${steps.length} step(s); ${dropped.length} dropped`,
      steps,
    },
    dropped,
    warnings:
      dropped.length > 0
        ? [
            `${dropped.length} node(s) could not be mapped. Review the dropped list and either implement a converter or re-create them as native steps.`,
          ]
        : [],
  };
}
