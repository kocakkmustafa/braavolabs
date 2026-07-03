/**
 * Handoff context-summary helper (E3 §2.5, D-015) — the ONE mechanical,
 * LLM-free summariser shared by every producer of `handoff_ledger.contextSummary`.
 *
 * Kept in its own dependency-light module (no prisma / memory / integrations)
 * so BOTH producers can import it without pulling the full handoff.service graph:
 *
 *   • handoff.service.createHandoff — writes the FIRST summary at ledger open
 *     time (may be empty on a manual RUNNING run whose step transcript is still
 *     null — the loop hasn't run a turn yet), and
 *   • claude.checkTurnBoundaryInterrupt — RE-derives the summary from the REAL
 *     checkpoint messages at the moment it freezes the ledger checkpoint (D-015:
 *     by then the transcript is populated, so the empty "No prior context
 *     captured." placeholder is replaced with the genuine mid-step note).
 *
 * One helper → the manual-early-handoff and automatic paths produce identical
 * summary text for the same transcript (§2.5). No cost, no cross-provider call.
 */

import type { TranscriptCheckpoint } from "../agent/claude";

/** The safe default when a handoff freezes with genuinely no captured context
 * (step-boundary handoff, or a run interrupted before its first turn produced
 * anything). Callers compare against this to detect "still empty". */
export const NO_PRIOR_CONTEXT = "No prior context captured.";

/**
 * Mechanical (LLM-free — §2.5) context summary. No cost, no dependency, no
 * cross-provider call: completed step names + the tail of the interrupted
 * step's last assistant message + any tool calls the model left pending. The
 * takeover reads this as the "here's where the last provider left off" note.
 *
 * `checkpoint` accepts anything carrying the checkpoint shape (`messages` +
 * optional `turn`/`costSoFarUsd`) — the live turn-boundary checkpoint the loop
 * freezes is a superset of what this reads.
 */
export function buildContextSummary(
  completedStepNames: string[],
  checkpoint: TranscriptCheckpoint | null,
): string {
  const parts: string[] = [];
  if (completedStepNames.length > 0) {
    parts.push(`Completed steps: ${completedStepNames.join(", ")}.`);
  }
  const messages = checkpoint?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.content) {
    parts.push(`Last provider left off: ${lastAssistant.content.slice(0, 500)}`);
  }
  const pendingToolCalls = lastAssistant?.toolCalls ?? [];
  if (pendingToolCalls.length > 0) {
    parts.push(`Pending tool calls: ${pendingToolCalls.map((t) => t.name).join(", ")}.`);
  }
  if (checkpoint) {
    parts.push(`(${checkpoint.turn} turn(s) into the step; $${checkpoint.costSoFarUsd.toFixed(4)} spent.)`);
  }
  return parts.join(" ") || NO_PRIOR_CONTEXT;
}
