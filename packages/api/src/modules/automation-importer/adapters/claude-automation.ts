/**
 * Claude Automation / Claude Code routine → Braavolabs pipeline.
 *
 * Routines look like a markdown file (or YAML frontmatter + markdown
 * body) that describes a sequence of Claude prompts and tool calls.
 * The auto-dev playbook bundles in /.claude/routines/auto-dev.md are
 * the reference shape — h2 headings become step names, fenced code
 * blocks become step bodies.
 *
 * This converter is best-effort: we look for h2 / h3 sections and emit
 * a script-type step per section, with the raw markdown body as the
 * step config. The user can refine in the dashboard.
 */

import type { ConvertedPipeline, RawStep } from "./types";
import { finalizeSteps } from "../agent-synthesis";

export function fromClaudeAutomation(payload: string): ConvertedPipeline {
  // Strip YAML frontmatter if present.
  const body = payload.replace(/^---\n[\s\S]*?\n---\n/, "");

  // Use h2 (## ) as the section delimiter — falls back to a single
  // catch-all step when the document doesn't have headings.
  const sections = body.split(/^##\s+/m).filter(Boolean);

  const rawSteps: RawStep[] = sections.map((section, idx) => {
    const firstLine = section.split("\n", 1)[0]?.trim() ?? `step-${idx + 1}`;
    return {
      id: `step-${idx + 1}`,
      type: "claude-routine-step",
      name: firstLine || `Step ${idx + 1}`,
      config: { title: firstLine, body: section },
    };
  });

  if (rawSteps.length === 0) {
    rawSteps.push({
      id: "step-1",
      type: "claude-routine-step",
      name: "Imported routine",
      config: { title: "Imported routine", body },
    });
  }

  const steps = finalizeSteps(rawSteps);

  // Detect "## Plan" / "## Implementation" / "## Verification" headers
  // common in auto-dev playbooks — surface as a warning so the user
  // knows we mapped them as scripts rather than as our native primitives.
  const warnings: string[] = [];
  if (/^##\s+(plan|implementation|verification|review)\b/im.test(body)) {
    warnings.push(
      "Auto-dev style routine detected — sections imported as script steps. Consider mapping Plan/Verify/Review into native primitives.",
    );
  }

  return {
    pipeline: {
      name: "Imported Claude routine",
      description: `Imported from Claude Automation / Claude Code (${steps.length} sections)`,
      steps,
    },
    dropped: [],
    warnings,
  };
}
