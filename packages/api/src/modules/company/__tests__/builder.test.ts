/**
 * company/builder.ts — D-013 honest provider resolution.
 *
 * startBuildSession's API-mode path (callAI) used to resolve its AI config
 * via the raw getTenantAIConfig, which silently fell through to the shared
 * system Anthropic key for ANY tenant without a usable BYOK row — no
 * plan-tier, allowSystemFallback OR counted-trial gate. This suite pins the
 * fix: resolveTenantCompletionLink returns the head of the same D-009 chain
 * the run loop dials (services/provider-chain.ts). An ineligible tenant now
 * gets startBuildSession's existing actionable 400 ("AI provider key
 * required...") instead of a silent system-funded completion; a BYOK or
 * trial-eligible tenant sees the build proceed, and a trial-served build
 * commits the run-based counter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const envMock = vi.hoisted(() => ({ LLM_PROVIDER: "api" as "api" | "local" }));
vi.mock("../../../config/env", () => ({ env: envMock }));

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tenantFindUnique = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());
const companyCount = vi.hoisted(() => vi.fn());
const companyCreate = vi.hoisted(() => vi.fn());
const agentCreate = vi.hoisted(() => vi.fn());
const pipelineCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const entitlementFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    entitlementEvent: { findMany: (...a: unknown[]) => entitlementFindMany(...a) },
  },
  tenantTx: (fn: (tx: unknown) => unknown) => fn({
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    company: {
      create: (...a: unknown[]) => companyCreate(...a),
      count: (...a: unknown[]) => companyCount(...a),
    },
    agent: { create: (...a: unknown[]) => agentCreate(...a) },
    pipeline: { create: (...a: unknown[]) => pipelineCreate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    entitlementEvent: { findMany: (...a: unknown[]) => entitlementFindMany(...a) },
  }),
}));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", () => ({
  chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
}));

const resolveTenantCompletionLinkMock = vi.hoisted(() => vi.fn());
const commitTrialCompletionMock = vi.hoisted(() => vi.fn());
const refundTrialCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/provider-chain", () => ({
  resolveTenantCompletionLink: (...a: unknown[]) => resolveTenantCompletionLinkMock(...a),
  commitTrialCompletion: (...a: unknown[]) => commitTrialCompletionMock(...a),
  refundTrialCompletion: (...a: unknown[]) => refundTrialCompletionMock(...a),
}));

import { startBuildSession, continueBuildSession, confirmBuild } from "../builder";
import { AppError } from "../../../middleware/error";

describe("startBuildSession — provider resolution honesty (D-013)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.LLM_PROVIDER = "api";
    // Provider-resolution cases use a valid, empty-ledger tenant below capacity.
    tenantFindUnique.mockResolvedValue({ plan: "INDIVIDUAL", companies: [] });
    entitlementFindMany.mockResolvedValue([]);
  });

  it("rejects an expired paid ledger before spending on a builder completion despite stale tenant.plan", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: { provider: "GROQ", model: "local-model", apiKey: "local-test-key" } });
    chatCompletionMock.mockResolvedValue({ content: JSON.stringify({ ready: false, questions: ["local question"] }), provider: "GROQ", inputTokens: 1, outputTokens: 1 });
    tenantFindUnique.mockResolvedValue({ plan: "INDIVIDUAL", companies: [] });
    entitlementFindMany.mockResolvedValue([{
      id: "local-expired-grant", source: "google", streamId: "local-google-stream",
      sourceTimestamp: new Date("2026-08-01T00:00:00Z"), type: "purchase", planTier: "INDIVIDUAL",
      expiresAt: new Date(Date.now() - 1_000), autoRenew: true,
    }]);

    await expect(startBuildSession("tenant-1", "local builder test")).resolves.toMatchObject({ status: "error", turn: 0, messages: [] });
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(resolveTenantCompletionLinkMock).not.toHaveBeenCalled();
  });

  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("preserves the empty-ledger %s builder baseline", async (plan) => {
    tenantFindUnique.mockResolvedValue({ plan, companies: [] });
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: { provider: "GROQ", model: "local-model", apiKey: "local-test-key" } });
    chatCompletionMock.mockResolvedValue({ content: JSON.stringify({ ready: false, questions: ["local question"] }), provider: "GROQ", inputTokens: 1, outputTokens: 1 });
    await expect(startBuildSession(`tenant-empty-${plan}`, "local builder test")).resolves.toMatchObject({ status: "clarifying" });
    expect(chatCompletionMock).toHaveBeenCalledOnce();
  });

  it("fails closed for a missing tenant before a first completion", async () => {
    tenantFindUnique.mockResolvedValue(null);
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: { provider: "GROQ", model: "local-model", apiKey: "local-test-key" } });
    chatCompletionMock.mockResolvedValue({ content: JSON.stringify({ ready: false, questions: ["local question"] }), provider: "GROQ", inputTokens: 1, outputTokens: 1 });
    await expect(startBuildSession("tenant-missing", "local builder test")).rejects.toMatchObject({ statusCode: 401 });
    expect(resolveTenantCompletionLinkMock).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("preserves the existing error response at the company cap before a first completion", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "INDIVIDUAL", companies: Array.from({ length: 5 }, (_, index) => ({ id: `co-${index}` })) });
    await expect(startBuildSession("tenant-full", "local builder test")).resolves.toMatchObject({ status: "error", turn: 0, messages: [] });
    expect(resolveTenantCompletionLinkMock).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it.each(["INDIVIDUAL", "TEAM"])("denies %s expiry between turns inside the one-hour session before completion or session mutation", async (plan) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T22:00:00Z"));
      tenantFindUnique.mockResolvedValue({ plan, companies: [] });
      entitlementFindMany.mockResolvedValue([{
        id: "expiring", source: "google", streamId: "mobile", sourceTimestamp: new Date("2026-10-01T21:00:00Z"),
        type: "purchase", planTier: plan, expiresAt: new Date("2026-10-01T22:01:00Z"), autoRenew: true,
      }]);
      resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: { provider: "GROQ", model: "local-model", apiKey: "local-test-key" } });
      chatCompletionMock.mockResolvedValue({ content: JSON.stringify({ ready: false, questions: ["local question"] }), provider: "GROQ", inputTokens: 1, outputTokens: 1 });
      const tenantId = `tenant-expiring-${plan}`;
      const session = await startBuildSession(tenantId, "local builder test");
      const previousMessages = session.messages.map((message) => ({ ...message }));
      const previousTurn = session.turn;
      vi.setSystemTime(new Date("2026-10-01T22:02:00Z"));
      vi.clearAllMocks();

      await expect(continueBuildSession(session.sessionId, tenantId, "new answer")).rejects.toMatchObject({ statusCode: 402 });
      expect(resolveTenantCompletionLinkMock).not.toHaveBeenCalled();
      expect(chatCompletionMock).not.toHaveBeenCalled();
      expect(session.messages).toEqual(previousMessages);
      expect(session.turn).toBe(previousTurn);
      expect(session.status).toBe("clarifying");
      expect(entitlementFindMany).toHaveBeenCalledWith({ where: { tenantId } });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["INDIVIDUAL", "TEAM", "CREATOR", "PRO"])("preserves empty-ledger %s continuation below company capacity", async (plan) => {
    tenantFindUnique.mockResolvedValue({ plan, companies: [] });
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: { provider: "GROQ", model: "local-model", apiKey: "local-test-key" } });
    chatCompletionMock.mockResolvedValue({ content: JSON.stringify({ ready: false, questions: ["local question"] }), provider: "GROQ", inputTokens: 1, outputTokens: 1 });
    const tenantId = `tenant-continuing-${plan}`;
    const session = await startBuildSession(tenantId, "local builder test");
    vi.clearAllMocks();
    await expect(continueBuildSession(session.sessionId, tenantId, "new answer")).resolves.toMatchObject({ status: "clarifying", turn: 2 });
    expect(entitlementFindMany).toHaveBeenCalledWith({ where: { tenantId } });
    expect(chatCompletionMock).toHaveBeenCalledOnce();
  });

  it.each(["missing", "full"])("denies continuation for a %s tenant before completion or session mutation", async (state) => {
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: { provider: "GROQ", model: "local-model", apiKey: "local-test-key" } });
    chatCompletionMock.mockResolvedValue({ content: JSON.stringify({ ready: false, questions: ["local question"] }), provider: "GROQ", inputTokens: 1, outputTokens: 1 });
    const tenantId = `tenant-continuation-${state}`;
    const session = await startBuildSession(tenantId, "local builder test");
    const previousMessages = session.messages.map((message) => ({ ...message }));
    tenantFindUnique.mockResolvedValue(state === "missing" ? null : { plan: "INDIVIDUAL", companies: Array.from({ length: 5 }, (_, index) => ({ id: `co-${index}` })) });
    vi.clearAllMocks();

    await expect(continueBuildSession(session.sessionId, tenantId, "new answer")).rejects.toMatchObject({ statusCode: state === "missing" ? 401 : 402 });
    expect(resolveTenantCompletionLinkMock).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(session.messages).toEqual(previousMessages);
    expect(session.turn).toBe(1);
  });

  it("HONESTY: ineligible tenant → actionable 400 AppError, chatCompletion NEVER called (no system spend)", async () => {
    resolveTenantCompletionLinkMock.mockRejectedValue(
      new Error("No AI provider configured. Please add an API key in Settings → AI Provider."),
    );

    await expect(startBuildSession("tenant-1", "a TikTok content factory for indie game devs")).rejects.toMatchObject(
      { statusCode: 400 } satisfies Partial<AppError>,
    );
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
  });

  it("eligible/BYOK tenant: resolved config is threaded straight into chatCompletion, unchanged", async () => {
    const resolvedConfig = { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-1" };
    resolveTenantCompletionLinkMock.mockResolvedValue({ provider: "GROQ", source: "byok-default", config: resolvedConfig });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({ ready: false, questions: ["What platform — TikTok, YouTube, or both?"] }),
      inputTokens: 12,
      outputTokens: 9,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    const session = await startBuildSession("tenant-1", "a TikTok content factory for indie game devs");

    expect(resolveTenantCompletionLinkMock).toHaveBeenCalledWith("tenant-1");
    expect(chatCompletionMock).toHaveBeenCalledWith(resolvedConfig, expect.any(String), expect.any(Array), 4096);
    expect(session.status).toBe("clarifying");
    // BYOK source → the trial counter must not be committed.
    expect(commitTrialCompletionMock).toHaveBeenCalledWith(
      "tenant-1", "byok-default", expect.objectContaining({ provider: "GROQ", model: "llama-3.3-70b-versatile" }),
    );
  });

  it("trial-served build: commits the run-based counter after a successful serve", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({ ready: false, questions: ["What platform — TikTok, YouTube, or both?"] }),
      inputTokens: 12,
      outputTokens: 9,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    await startBuildSession("tenant-1", "a TikTok content factory for indie game devs");

    expect(commitTrialCompletionMock).toHaveBeenCalledWith(
      "tenant-1", "trial", expect.objectContaining({ provider: "GROQ", model: "llama-3.3-70b-versatile" }),
    );
  });

  it("REFUND: trial-served build throws → the reservation is refunded, not committed or stranded", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockRejectedValue(new Error("GROQ timeout after 30s"));

    await expect(
      startBuildSession("tenant-1", "a TikTok content factory for indie game devs"),
    ).rejects.toThrow();

    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
    expect(refundTrialCompletionMock).toHaveBeenCalledWith("tenant-1", "trial");
  });

  it("confirm rechecks capacity after the AI session and writes nothing when the plan is full", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ", source: "byok-default",
      config: { provider: "GROQ", model: "test-model", apiKey: "synthetic" },
    });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({ ready: false, questions: ["What is the audience?"] }),
      inputTokens: 1, outputTokens: 1, provider: "GROQ", model: "test-model",
    });
    const session = await startBuildSession("tenant-1", "a test studio for launch readiness");
    // The builder keeps this exact session object in its in-memory map. Move
    // it to the confirm stage without exercising buildSpec's dynamic require.
    session.status = "ready";
    session.companySpec = {
      name: "Test Studio", slug: "test-studio", description: "Test",
      primitives: ["CONTENT"], agents: [], pipelines: [], config: {},
    };
    expect(session.status).toBe("ready");
    queryRaw.mockResolvedValue([{ plan: "MANUAL_REVIEW" }]);
    companyCount.mockResolvedValue(0);

    await expect(confirmBuild(session.sessionId, "tenant-1")).rejects.toMatchObject({ statusCode: 402 });
    expect(companyCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
    expect(companyCreate).not.toHaveBeenCalled();
    expect(agentCreate).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();

    queryRaw.mockResolvedValue([{ plan: "INDIVIDUAL" }]);
    companyCount.mockResolvedValue(4);
    companyCreate.mockResolvedValue({ id: "co-1", name: "Test Studio" });
    activityLogCreate.mockResolvedValue({});
    const created = await confirmBuild(session.sessionId, "tenant-1");
    expect(created.status).toBe("created");
    expect(created.companyId).toBe("co-1");
    expect(companyCreate).toHaveBeenCalledOnce();
  });
});
