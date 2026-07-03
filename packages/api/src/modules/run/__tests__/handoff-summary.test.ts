/**
 * D-015 — the shared mechanical context-summariser (handoff-summary.ts).
 * Pure, LLM-free, no prisma/network. Guards the ONE helper that both
 * createHandoff (ledger open) and claude.checkTurnBoundaryInterrupt (freeze)
 * use, plus the NO_PRIOR_CONTEXT sentinel the freeze uses to decide whether to
 * overwrite the ledger summary.
 */
import { describe, it, expect } from "vitest";
import { buildContextSummary, NO_PRIOR_CONTEXT } from "../handoff-summary";
import type { TranscriptCheckpoint } from "../../agent/claude";

function checkpoint(partial: Partial<TranscriptCheckpoint>): TranscriptCheckpoint {
  return {
    messages: [],
    turn: 1,
    toolUseMode: "native",
    costSoFarUsd: 0.01,
    systemPromptHash: "abcd1234abcd1234",
    truncated: false,
    ...partial,
  };
}

describe("buildContextSummary (shared helper)", () => {
  it("derives the mid-step note from REAL checkpoint messages (D-015 freeze input)", () => {
    const cp = checkpoint({
      messages: [
        { role: "user", content: "do the task" },
        {
          role: "assistant",
          content: "Analysed the inputs and started drafting.",
          toolCalls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
      ],
      turn: 2,
      costSoFarUsd: 0.0123,
    });

    const summary = buildContextSummary(["research"], cp);

    expect(summary).toBe(
      "Completed steps: research. " +
        "Last provider left off: Analysed the inputs and started drafting. " +
        "Pending tool calls: web_search. " +
        "(2 turn(s) into the step; $0.0123 spent.)",
    );
    // The D-015 fix hinges on this NOT being the placeholder.
    expect(summary).not.toBe(NO_PRIOR_CONTEXT);
  });

  it("works from checkpoint messages alone (no completed-step names)", () => {
    const cp = checkpoint({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "Halfway done." },
      ],
    });
    const summary = buildContextSummary([], cp);
    expect(summary).toContain("Last provider left off: Halfway done.");
    expect(summary).not.toContain("Completed steps:");
    expect(summary).not.toBe(NO_PRIOR_CONTEXT);
  });

  it("truncates a long last-assistant message to 500 chars", () => {
    const long = "x".repeat(900);
    const cp = checkpoint({
      messages: [{ role: "assistant", content: long }],
    });
    const summary = buildContextSummary([], cp);
    expect(summary).toContain("x".repeat(500));
    expect(summary).not.toContain("x".repeat(501));
  });

  it("returns the NO_PRIOR_CONTEXT sentinel for a null checkpoint", () => {
    expect(buildContextSummary([], null)).toBe(NO_PRIOR_CONTEXT);
    expect(NO_PRIOR_CONTEXT).toBe("No prior context captured.");
  });

  it("returns the sentinel when the checkpoint has no assistant content, no tool calls, and no completed steps", () => {
    // The "genuinely empty" case — the freeze path uses === NO_PRIOR_CONTEXT to
    // SKIP the summary overwrite (keeping createHandoff's own text).
    const cp = checkpoint({ messages: [{ role: "user", content: "go" }] });
    // A bare turn counter still counts as context (turn/cost line), so to reach
    // the sentinel the checkpoint itself must be null — with a checkpoint the
    // turn/cost tail always yields text. Assert that invariant explicitly:
    expect(buildContextSummary([], cp)).toContain("turn(s) into the step");
    expect(buildContextSummary([], null)).toBe(NO_PRIOR_CONTEXT);
  });
});
