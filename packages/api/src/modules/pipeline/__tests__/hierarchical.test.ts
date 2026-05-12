import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/db", () => ({
  prisma: {
    agent: { findMany: vi.fn(), findUnique: vi.fn() },
    runStep: { create: vi.fn() },
  },
}));

import {
  buildManagerContext,
  resolveWorker,
  trackDelegation,
  clearDelegationCounter,
} from "../hierarchical";
import { prisma } from "../../../lib/db";

const findUnique = prisma.agent.findUnique as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildManagerContext", () => {
  it("renders an empty-team fallback when no workers", () => {
    const ctx = buildManagerContext([], 3);
    expect(ctx).toMatch(/empty team/i);
  });

  it("lists every worker with id, role, and tool roster", () => {
    const ctx = buildManagerContext(
      [
        {
          id: "a1",
          name: "Researcher",
          role: "Senior researcher",
          tools: ["web_search", "knowledge_base_search"],
          model: "claude-sonnet-4-5-20250929",
          systemPrompt: "",
          companyId: "co1",
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ],
      5,
    );
    expect(ctx).toContain('id="a1"');
    expect(ctx).toContain("Researcher");
    expect(ctx).toContain("Senior researcher");
    expect(ctx).toContain("web_search");
    expect(ctx).toContain("Maximum delegation depth from this manager is 5");
  });
});

describe("resolveWorker", () => {
  it("returns the agent when company matches", async () => {
    findUnique.mockResolvedValue({ id: "a1", companyId: "co1", name: "X" });
    const agent = await resolveWorker("a1", "co1");
    expect(agent.id).toBe("a1");
  });

  it("refuses cross-company delegation", async () => {
    findUnique.mockResolvedValue({ id: "a1", companyId: "co-other", name: "X" });
    await expect(resolveWorker("a1", "co1")).rejects.toThrow(/cross-company/i);
  });

  it("404s on unknown agent id", async () => {
    findUnique.mockResolvedValue(null);
    await expect(resolveWorker("nope", "co1")).rejects.toThrow(/Unknown worker agent/);
  });
});

describe("trackDelegation", () => {
  it("throws once the delegation cap is hit", () => {
    const runId = "run-1";
    // cap = maxDepth × 4 = 12
    for (let i = 0; i < 12; i++) {
      trackDelegation(runId, 3);
    }
    expect(() => trackDelegation(runId, 3)).toThrow(/Delegation cap exceeded/);
    clearDelegationCounter(runId);
  });

  it("clears the counter on demand", () => {
    const runId = "run-2";
    for (let i = 0; i < 4; i++) trackDelegation(runId, 2);
    clearDelegationCounter(runId);
    // After clear, should be able to delegate again from zero.
    expect(() => trackDelegation(runId, 2)).not.toThrow();
    clearDelegationCounter(runId);
  });
});
