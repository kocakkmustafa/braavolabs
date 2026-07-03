/**
 * OpenClaw / NemoClaw skill bundle → Braavolabs pipeline.
 *
 * Both share a "skill manifest" format: JSON with `name`, `description`,
 * `tools` (array of tool definitions), and `prompts` (system + user
 * templates). We map each tool to a native step and roll prompts into
 * the LLM step config.
 *
 * Real bundle parsing (.zip with manifest.json + assets) lives in a
 * follow-up — this stub accepts a JSON-only shape so the contract is
 * stable for the dashboard preview path.
 */

import type { ConvertedPipeline, RawStep } from "./types";
import { finalizeSteps } from "../agent-synthesis";

interface SkillTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface SkillManifest {
  name?: string;
  description?: string;
  tools?: SkillTool[];
  prompts?: { system?: string; user?: string };
}

export function fromOpenClaw(payload: string): ConvertedPipeline {
  let manifest: SkillManifest;
  try {
    manifest = JSON.parse(payload) as SkillManifest;
  } catch (err) {
    throw new Error(
      `Invalid OpenClaw / NemoClaw manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawSteps: RawStep[] = [];

  if (manifest.prompts?.system || manifest.prompts?.user) {
    rawSteps.push({
      id: "prompt",
      type: "llm",
      name: "Prompt",
      config: {
        systemPrompt: manifest.prompts.system ?? "",
        userPrompt: manifest.prompts.user ?? "",
      },
    });
  }

  for (const [idx, tool] of (manifest.tools ?? []).entries()) {
    rawSteps.push({
      id: `tool-${idx + 1}`,
      type: "tool",
      name: tool.name,
      config: { name: tool.name, description: tool.description, parameters: tool.parameters ?? {} },
    });
  }

  const steps = finalizeSteps(rawSteps);

  return {
    pipeline: {
      name: manifest.name ?? "Imported skill bundle",
      description: manifest.description ?? `Imported from OpenClaw/NemoClaw (${steps.length} step(s))`,
      steps,
    },
    dropped: [],
    warnings: steps.length === 0 ? ["Manifest had no tools or prompts — empty pipeline created."] : [],
  };
}
