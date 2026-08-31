import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const researchSessionMock = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));
const researchSourceCreateMock = vi.hoisted(() => vi.fn());
const runAgentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    webResearchSession: researchSessionMock,
    webResearchSource: { create: researchSourceCreateMock },
  },
}));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../agent/claude", () => ({
  runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
}));

vi.mock("../../../services/multi-model", () => ({
  compareAcrossModels: vi.fn(),
}));

import { startResearch } from "../research.service";

const originalResearchProvider = process.env.WEB_RESEARCH_PROVIDER;
const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

function persistedSession(tenantId: unknown) {
  return {
    id: "research-session-1",
    tenantId,
    companyId: "company-1",
    query: "Compare deterministic migration strategies",
    maxRounds: 1,
    maxSources: 5,
    maxCostUsd: 1,
    status: "PENDING",
  };
}

function loopResult(finalContent: string) {
  return { finalContent, totalCostUsd: 0, turns: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEB_RESEARCH_PROVIDER = "tavily";
  process.env.TAVILY_API_KEY = "test-search-key";
  process.env.ANTHROPIC_API_KEY = "shared-system-key-must-not-be-used";

  researchSessionMock.create.mockResolvedValue({ id: "research-session-1" });
  researchSessionMock.update.mockImplementation(async ({ data }: { data: unknown }) => data);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ results: [] }),
  } as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalResearchProvider === undefined) delete process.env.WEB_RESEARCH_PROVIDER;
  else process.env.WEB_RESEARCH_PROVIDER = originalResearchProvider;
  if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyKey;
  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
});

describe("research background loop — tenant-owned BYOK/local only", () => {
  it("passes the persisted session tenant to both distill and final synthesis", async () => {
    researchSessionMock.findUnique.mockResolvedValue(persistedSession("tenant-from-database"));
    runAgentLoopMock
      .mockResolvedValueOnce(loopResult('{"done":false,"followUps":[]}'))
      .mockResolvedValueOnce(loopResult('{"summary":"done","claims":[]}'));

    await startResearch({
      tenantId: "tenant-from-authenticated-caller",
      companyId: "company-1",
      query: "Compare deterministic migration strategies",
    });

    await vi.waitFor(() => expect(runAgentLoopMock).toHaveBeenCalledTimes(2));
    expect(runAgentLoopMock.mock.calls.map(([config]) => config.tenantId)).toEqual([
      "tenant-from-database",
      "tenant-from-database",
    ]);
    expect(runAgentLoopMock.mock.calls.every(([config]) => config.aiConfigOverride === undefined)).toBe(true);
  });

  it.each([undefined, "   "])(
    "fails closed for missing/corrupt persisted tenant %p before search or model invocation",
    async (tenantId) => {
      researchSessionMock.findUnique.mockResolvedValue(persistedSession(tenantId));
      runAgentLoopMock.mockResolvedValue(loopResult('{"summary":"must-not-run","claims":[]}'));

      await startResearch({
        tenantId: "tenant-from-authenticated-caller",
        companyId: "company-1",
        query: "Compare deterministic migration strategies",
      });

      await vi.waitFor(() => {
        expect(researchSessionMock.update).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({ status: "FAILED" }),
        }));
      });
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps request-body tenant identity out of the authenticated research contract", () => {
    const routerSource = readFileSync(
      fileURLToPath(new URL("../research.router.ts", import.meta.url)),
      "utf8",
    );
    const startSchema = routerSource.match(/const startSchema = z\.object\(\{[\s\S]*?\n\}\);/)?.[0];

    expect(startSchema).toBeDefined();
    expect(startSchema).not.toMatch(/\btenantId\b/);
    expect(routerSource).toMatch(/startResearch\(\{\s*tenantId:\s*req\.auth!\.tenantId,/);
  });
});
