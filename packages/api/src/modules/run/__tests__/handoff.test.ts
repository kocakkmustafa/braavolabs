/**
 * E3/T3 — handoff service + automatic trigger + expiry HANDOFF branch.
 * Mocked prisma / memory / provider-chain, zero network. Covers the plan's
 * required paths (plan §2.3b/§2.5, adversarial B3/B4a/B6.1/B6.2):
 *
 *   • MARKED FAILOVER (ProviderExhaustedError, FAILOVER) on a tenant WITH a
 *     viable second link → ledger OPEN + HANDOFF Approval(suggestedProvider),
 *   • viable target absent → ledger OPEN, NO approval (B4a),
 *   • UNMARKED generic error ("No AI provider configured") → NOTHING opened,
 *   • FATAL marker (400) → NOTHING opened (isHandoffTriggerEligible false),
 *   • createHandoff throwing is swallowed by the executor — step stays FAILED,
 *     never re-thrown (B6.2),
 *   • gitState is null when the company has no GITHUB integration,
 *   • storeEpisodicMemory is called EXACTLY once with source=runId,
 *   • expiry cron's HANDOFF branch REJECTS the approval but does NOT cancel the
 *     run and does NOT touch the ledger (B6.1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before importing the SUTs) ──

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runFindUnique = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const runStepFindFirst = vi.hoisted(() => vi.fn());
const runStepFindMany = vi.hoisted(() => vi.fn());
const runStepFindUnique = vi.hoisted(() => vi.fn());
const runStepUpdate = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());
const handoffFindUnique = vi.hoisted(() => vi.fn());
const handoffCreate = vi.hoisted(() => vi.fn());
const handoffUpdate = vi.hoisted(() => vi.fn());
const approvalCreate = vi.hoisted(() => vi.fn());
const approvalFindMany = vi.hoisted(() => vi.fn());
const approvalUpdateMany = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: {
      findUnique: (...a: unknown[]) => runFindUnique(...a),
      update: (...a: unknown[]) => runUpdate(...a),
    },
    runStep: {
      findFirst: (...a: unknown[]) => runStepFindFirst(...a),
      findMany: (...a: unknown[]) => runStepFindMany(...a),
      findUnique: (...a: unknown[]) => runStepFindUnique(...a),
      update: (...a: unknown[]) => runStepUpdate(...a),
    },
    handoffLedger: {
      findFirst: (...a: unknown[]) => handoffFindFirst(...a),
      findUnique: (...a: unknown[]) => handoffFindUnique(...a),
      create: (...a: unknown[]) => handoffCreate(...a),
      update: (...a: unknown[]) => handoffUpdate(...a),
    },
    approval: {
      create: (...a: unknown[]) => approvalCreate(...a),
      findMany: (...a: unknown[]) => approvalFindMany(...a),
      updateMany: (...a: unknown[]) => approvalUpdateMany(...a),
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

const publishRunEventMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/runEvents", () => ({
  publishRunEvent: (...a: unknown[]) => publishRunEventMock(...a),
}));

const storeEpisodicMemoryMock = vi.hoisted(() => vi.fn());
vi.mock("@ai-company-os/memory", () => ({
  storeEpisodicMemory: (...a: unknown[]) => storeEpisodicMemoryMock(...a),
}));

const listTenantProviderLinksMock = vi.hoisted(() => vi.fn());
const isProviderTrippedMock = vi.hoisted(() => vi.fn());
// ProviderExhaustedError + isHandoffTriggerEligible stay REAL — the trigger
// guard is exactly what's under test.
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return {
    ...actual,
    listTenantProviderLinks: (...a: unknown[]) => listTenantProviderLinksMock(...a),
    isProviderTripped: (...a: unknown[]) => isProviderTrippedMock(...a),
  };
});

// getActiveIntegration mocked to "no GITHUB integration" by default (gitState
// null path). captureGitState dynamic-imports this module.
const getActiveIntegrationMock = vi.hoisted(() => vi.fn());
vi.mock("../../integration/checker", () => ({
  getActiveIntegration: (...a: unknown[]) => getActiveIntegrationMock(...a),
}));

import {
  createHandoff,
  claimHandoff,
  buildContextSummary,
  resolveViableHandoffTarget,
  HandoffClaimError,
  CHECKPOINT_STALE_MS,
} from "../handoff.service";
import { maybeOpenAutoHandoff } from "../handoff.trigger";
import { ProviderExhaustedError } from "../../../services/provider-chain";

const RUN_CTX = {
  id: "run-1",
  status: "FAILED",
  pipeline: { company: { id: "co-1", tenantId: "tenant-1" } },
};

const CHECKPOINT = {
  messages: [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "I called a tool", toolCalls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] },
    { role: "tool", toolCallId: "c1", content: "{}" },
  ],
  turn: 1,
  toolUseMode: "native",
  costSoFarUsd: 0.02,
  systemPromptHash: "abc123",
  truncated: false,
};

function link(provider: string, model: string) {
  return { provider, source: "byok-fallback", config: { provider, model, apiKey: "k" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  runFindUnique.mockResolvedValue(RUN_CTX);
  runUpdate.mockResolvedValue({});
  runStepFindFirst.mockResolvedValue({ id: "rs-1", stepIndex: 0, transcript: CHECKPOINT });
  runStepFindMany.mockResolvedValue([{ name: "research" }]);
  runStepFindUnique.mockResolvedValue({ transcript: CHECKPOINT });
  runStepUpdate.mockResolvedValue({});
  handoffFindFirst.mockResolvedValue(null); // no existing OPEN ledger
  handoffCreate.mockImplementation((args: any) =>
    Promise.resolve({ id: "hl-1", tenantId: "tenant-1", runId: "run-1", stepIndex: 0, status: "OPEN", ...args.data }),
  );
  handoffUpdate.mockImplementation((args: any) => Promise.resolve({ id: "hl-1", ...args.data }));
  handoffFindUnique.mockResolvedValue(null);
  approvalCreate.mockResolvedValue({ id: "ap-1" });
  activityLogCreate.mockResolvedValue({});
  storeEpisodicMemoryMock.mockResolvedValue("mem-1");
  getActiveIntegrationMock.mockResolvedValue(null); // no GITHUB integration
  listTenantProviderLinksMock.mockResolvedValue([]);
  isProviderTrippedMock.mockReturnValue(false);
  publishRunEventMock.mockResolvedValue(undefined);
});

// ── Trigger guard (B3) ──

describe("automatic trigger guard — only marked, trustworthy chain-exhaustion", () => {
  it("MARKED FAILOVER + viable second link → ledger OPEN + HANDOFF Approval(suggestedProvider)", async () => {
    listTenantProviderLinksMock.mockResolvedValue([link("OPENAI", "gpt-4o")]);
    const err = ProviderExhaustedError.wrap("FAILOVER", "ANTHROPIC", "claude-sonnet-4-5", new Error("401 unauthorized"));

    const handoffId = await maybeOpenAutoHandoff("run-1", err);

    expect(handoffId).toBe("hl-1");
    expect(handoffCreate).toHaveBeenCalledTimes(1);
    expect(handoffCreate.mock.calls[0][0].data).toMatchObject({
      runId: "run-1",
      fromProvider: "ANTHROPIC",
      fromModel: "claude-sonnet-4-5",
      reason: "PROVIDER_FAILOVER",
      status: "OPEN",
    });
    // Approval created with the viable provider.
    expect(approvalCreate).toHaveBeenCalledTimes(1);
    expect(approvalCreate.mock.calls[0][0].data).toMatchObject({
      type: "HANDOFF",
      status: "PENDING",
      metadata: { handoffId: "hl-1", suggestedProvider: "OPENAI", suggestedModel: "gpt-4o" },
    });
  });

  it("MARKED FAILOVER but NO viable target → ledger OPEN, NO approval (B4a)", async () => {
    // Only the dead provider is configured — no alternative link.
    listTenantProviderLinksMock.mockResolvedValue([link("ANTHROPIC", "claude-sonnet-4-5")]);
    const err = ProviderExhaustedError.wrap("FAILOVER", "ANTHROPIC", "claude-sonnet-4-5", new Error("401"));

    const handoffId = await maybeOpenAutoHandoff("run-1", err);

    expect(handoffId).toBe("hl-1");
    expect(handoffCreate).toHaveBeenCalledTimes(1);
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("a viable link on the same provider that is TRIPPED is not offered (B4a)", async () => {
    listTenantProviderLinksMock.mockResolvedValue([link("OPENAI", "gpt-4o")]);
    isProviderTrippedMock.mockReturnValue(true); // OPENAI breaker open
    const err = ProviderExhaustedError.wrap("FAILOVER", "ANTHROPIC", "claude-sonnet-4-5", new Error("401"));

    await maybeOpenAutoHandoff("run-1", err);

    expect(handoffCreate).toHaveBeenCalledTimes(1);
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("UNMARKED generic error ('No AI provider configured') → NOTHING opened", async () => {
    const err = new Error("No AI provider configured. Please add an API key in Settings → AI Provider.");
    const handoffId = await maybeOpenAutoHandoff("run-1", err);

    expect(handoffId).toBeNull();
    expect(handoffCreate).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("FATAL marker (400) → NOTHING opened (not handoff-eligible)", async () => {
    // A FATAL classification never earns a handoff — the same doomed request
    // would die on any provider.
    const err = ProviderExhaustedError.wrap("FATAL", "ANTHROPIC", "claude-sonnet-4-5", new Error("400 bad request"));
    const handoffId = await maybeOpenAutoHandoff("run-1", err);

    expect(handoffId).toBeNull();
    expect(handoffCreate).not.toHaveBeenCalled();
  });

  it("default-TRANSIENT (marker WITHOUT status) → NOTHING opened (B3)", async () => {
    // classification TRANSIENT but status undefined = the classifier's default
    // guess on an unknown error — NOT trustworthy, never a ledger.
    const err = new ProviderExhaustedError("TRANSIENT", undefined, "ANTHROPIC", "claude-sonnet-4-5", new Error("weird blip"));
    const handoffId = await maybeOpenAutoHandoff("run-1", err);

    expect(handoffId).toBeNull();
    expect(handoffCreate).not.toHaveBeenCalled();
  });

  it("TRANSIENT WITH a real status (429) → ledger opens (PROVIDER_EXHAUSTED reason)", async () => {
    listTenantProviderLinksMock.mockResolvedValue([link("GROQ", "llama-3.3-70b")]);
    const err = new ProviderExhaustedError("TRANSIENT", 429, "OPENAI", "gpt-4o", new Error("429 rate limited"));
    const handoffId = await maybeOpenAutoHandoff("run-1", err);

    expect(handoffId).toBe("hl-1");
    expect(handoffCreate.mock.calls[0][0].data.reason).toBe("PROVIDER_EXHAUSTED");
  });

  it("auto trigger freezes the checkpoint from transcript EVEN on a still-RUNNING run (§2.3b — loop is dead)", async () => {
    // The runner finalizes FAILED only AFTER executeStep returns, so the auto
    // trigger fires while the run is momentarily RUNNING. A null checkpoint
    // here would strand the ledger behind the 120s stale timer — freeze now.
    runFindUnique.mockResolvedValue({ ...RUN_CTX, status: "RUNNING" });
    listTenantProviderLinksMock.mockResolvedValue([link("OPENAI", "gpt-4o")]);
    const err = ProviderExhaustedError.wrap("FAILOVER", "ANTHROPIC", "claude", new Error("401"));

    await maybeOpenAutoHandoff("run-1", err);

    const created = handoffCreate.mock.calls[0][0].data;
    expect(created.checkpoint).toMatchObject({ turn: 1 }); // DOLU, not null
  });
});

// ── createHandoff behaviour ──

describe("createHandoff", () => {
  it("stores episodic memory EXACTLY once with source=runId", async () => {
    await createHandoff({
      runId: "run-1",
      reason: "MANUAL",
      fromProvider: "ANTHROPIC",
      fromModel: "claude-sonnet-4-5",
    });
    expect(storeEpisodicMemoryMock).toHaveBeenCalledTimes(1);
    expect(storeEpisodicMemoryMock.mock.calls[0][0]).toMatchObject({
      companyId: "co-1",
      type: "EPISODIC",
      source: "run-1",
    });
  });

  it("gitState is null when the company has no GITHUB integration", async () => {
    getActiveIntegrationMock.mockResolvedValue(null);
    await createHandoff({ runId: "run-1", reason: "MANUAL", fromProvider: "ANTHROPIC", fromModel: "m" });
    const created = handoffCreate.mock.calls[0][0].data;
    expect(created.gitState).toBeUndefined(); // null → omitted from the create payload
  });

  it("RUNNING run → checkpoint LEFT NULL (live loop freezes it)", async () => {
    runFindUnique.mockResolvedValue({ ...RUN_CTX, status: "RUNNING" });
    await createHandoff({ runId: "run-1", reason: "MANUAL", fromProvider: "ANTHROPIC", fromModel: "m" });
    const created = handoffCreate.mock.calls[0][0].data;
    expect(created.checkpoint).toBeUndefined(); // null → omitted
  });

  it("non-RUNNING run copies the frozen transcript into checkpoint", async () => {
    await createHandoff({ runId: "run-1", reason: "MANUAL", fromProvider: "ANTHROPIC", fromModel: "m" });
    const created = handoffCreate.mock.calls[0][0].data;
    expect(created.checkpoint).toMatchObject({ turn: 1, toolUseMode: "native" });
  });

  it("returns the EXISTING OPEN ledger instead of stacking a duplicate (§2.3a uniqueness)", async () => {
    handoffFindFirst.mockResolvedValue({ id: "hl-existing", status: "OPEN" });
    const ledger = await createHandoff({ runId: "run-1", reason: "MANUAL", fromProvider: "ANTHROPIC", fromModel: "m" });
    expect(ledger.id).toBe("hl-existing");
    expect(handoffCreate).not.toHaveBeenCalled();
  });
});

// ── claimHandoff checkpoint gate (B2) ──

describe("claimHandoff", () => {
  it("null checkpoint younger than the stale threshold → CHECKPOINT_PENDING", async () => {
    handoffFindUnique.mockResolvedValue({
      id: "hl-1",
      status: "OPEN",
      checkpoint: null,
      createdAt: new Date(Date.now() - 1_000), // 1s old
      tenantId: "tenant-1",
      runId: "run-1",
      runStepId: "rs-1",
    });
    await expect(
      claimHandoff({ handoffId: "hl-1", provider: "OLLAMA", model: "gemma3:4b" }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_PENDING" });
  });

  it("null checkpoint PAST the stale threshold → recovers from run_steps.transcript and claims", async () => {
    handoffFindUnique.mockResolvedValue({
      id: "hl-1",
      status: "OPEN",
      checkpoint: null,
      createdAt: new Date(Date.now() - CHECKPOINT_STALE_MS - 1_000),
      tenantId: "tenant-1",
      runId: "run-1",
      runStepId: "rs-1",
    });
    const claimed = await claimHandoff({ handoffId: "hl-1", provider: "OLLAMA", model: "gemma3:4b" });
    // The stale-recovery update AND the CLAIMED update both fire.
    expect(handoffUpdate).toHaveBeenCalledTimes(2);
    expect(claimed.status).toBe("CLAIMED");
    expect(claimed.toProvider).toBe("OLLAMA");
  });

  it("full checkpoint → claims immediately", async () => {
    handoffFindUnique.mockResolvedValue({
      id: "hl-1",
      status: "OPEN",
      checkpoint: CHECKPOINT,
      createdAt: new Date(),
      tenantId: "tenant-1",
      runId: "run-1",
      runStepId: "rs-1",
    });
    const claimed = await claimHandoff({ handoffId: "hl-1", provider: "OPENAI", model: "gpt-4o" });
    expect(handoffUpdate).toHaveBeenCalledTimes(1); // only the CLAIMED update
    expect(claimed.status).toBe("CLAIMED");
  });

  it("a non-OPEN ledger is not claimable", async () => {
    handoffFindUnique.mockResolvedValue({ id: "hl-1", status: "CLAIMED", createdAt: new Date() });
    await expect(
      claimHandoff({ handoffId: "hl-1", provider: "OLLAMA", model: "m" }),
    ).rejects.toBeInstanceOf(HandoffClaimError);
  });
});

// ── resolveViableHandoffTarget ──

describe("resolveViableHandoffTarget", () => {
  it("skips the from-provider and tripped links, returns the first viable", async () => {
    listTenantProviderLinksMock.mockResolvedValue([
      link("ANTHROPIC", "claude"),
      link("OPENAI", "gpt-4o"),
    ]);
    const target = await resolveViableHandoffTarget("tenant-1", "ANTHROPIC");
    expect(target).toEqual({ provider: "OPENAI", model: "gpt-4o" });
  });

  it("returns null when the only link is the dead provider", async () => {
    listTenantProviderLinksMock.mockResolvedValue([link("ANTHROPIC", "claude")]);
    expect(await resolveViableHandoffTarget("tenant-1", "ANTHROPIC")).toBeNull();
  });
});

// ── buildContextSummary (mechanical, LLM-free) ──

describe("buildContextSummary", () => {
  it("summarizes completed steps + last assistant tail + pending tool calls without an LLM", () => {
    const summary = buildContextSummary(["research", "draft"], CHECKPOINT as any);
    expect(summary).toContain("research, draft");
    expect(summary).toContain("I called a tool");
    expect(summary).toContain("web_search");
  });

  it("handles a null checkpoint gracefully", () => {
    expect(buildContextSummary([], null)).toBe("No prior context captured.");
  });
});
