/**
 * SEC-BRA-04d (5) — local-default cloud filtering exercised through the REAL
 * provider-chain (only prisma / env / crypto / the agent loop are mocked), so
 * a regression in listTenantProviderLinks or isCloudBlockedByLocalDefault is
 * caught on the cascade and multi-model paths too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/env", () => ({
  env: { ANTHROPIC_API_KEY: undefined, CLAUDE_MODEL: "claude-sonnet-4-5", OFFLINE_MODE: false },
}));
vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const findMany = vi.hoisted(() => vi.fn());
vi.mock("../../lib/db", () => ({
  prisma: { userAIConfig: { findMany: (...a: unknown[]) => findMany(...a) }, tenant: { findUnique: vi.fn() } },
}));
vi.mock("../../lib/encryption", () => ({
  decryptForTenant: (b: string) => `plain-${b}`,
  encryptForTenant: vi.fn(() => "enc"),
}));
vi.mock("../trial-llm", () => ({
  tryConsumeTrialRun: vi.fn(), commitTrialRun: vi.fn(), refundTrialReservation: vi.fn(),
}));
const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../modules/agent/claude", () => ({
  runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a),
}));

import { runTenantSelectedCascade } from "../../modules/research/cascade.service";
import { validateModelSelections, compareAcrossModels } from "../multi-model";
import { listTenantProviderLinks, LOCAL_DEFAULT_CLOUD_BLOCKED_MESSAGE } from "../provider-chain";
import { logger } from "../../lib/logger";

const T = "tenant-real";
function row(provider: string, model: string, o: Record<string, unknown> = {}) {
  return {
    id: provider, tenantId: T, provider, model,
    encryptedApiKey: o.key === null ? null : `k-${provider}`,
    baseUrl: null, isDefault: false, fallbackOrder: null, allowSystemFallback: false,
    createdAt: new Date(2026, 0, 1), ...o,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("real provider-chain: local default + keyed cloud row", () => {
  beforeEach(() => {
    findMany.mockResolvedValue([
      row("OLLAMA", "gemma3:4b", { key: null, isDefault: true }),
      row("OPENAI", "gpt-4o", { fallbackOrder: 1 }),
    ]);
  });

  it("cascade (selected cloud model) → privacy message, no dial", async () => {
    await expect(
      runTenantSelectedCascade(T, "q", { provider: "OPENAI", model: "gpt-4o" }),
    ).rejects.toThrow(LOCAL_DEFAULT_CLOUD_BLOCKED_MESSAGE);
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("multi-model validate → privacy message", async () => {
    await expect(
      validateModelSelections(T, [{ provider: "OPENAI", model: "gpt-4o" }]),
    ).rejects.toThrow(LOCAL_DEFAULT_CLOUD_BLOCKED_MESSAGE);
  });

  it("multi-model compare only ever dials the local candidate", async () => {
    runAgentLoopMock.mockResolvedValue({
      finalContent: "answer", turns: [], totalInputTokens: 1, totalOutputTokens: 1, totalCostUsd: 0, totalToolCalls: 0,
    });
    await compareAcrossModels(T, "task").catch(() => undefined);
    const providers = runAgentLoopMock.mock.calls.map((c) => (c[0] as any).aiConfigOverride?.provider).filter(Boolean);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((p) => p === "OLLAMA")).toBe(true);
  });

  it("filter note is not a warn (SEC-BRA-04d logger noise)", async () => {
    await listTenantProviderLinks(T);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("real provider-chain: local default but cloud provider NOT configured", () => {
  it("cascade / validate keep the generic 'unavailable' message (no false privacy claim)", async () => {
    findMany.mockResolvedValue([
      row("OLLAMA", "gemma3:4b", { key: null, isDefault: true }),
      row("GROQ", "llama", { key: null, fallbackOrder: 1 }), // keyless cloud row: unusable
    ]);
    await expect(
      runTenantSelectedCascade(T, "q", { provider: "OPENAI", model: "gpt-4o" }),
    ).rejects.toThrow("Model selection is unavailable or unsupported for this tenant");
    await expect(
      runTenantSelectedCascade(T, "q", { provider: "GROQ", model: "llama" }),
    ).rejects.toThrow("Model selection is unavailable or unsupported for this tenant");
    await expect(
      validateModelSelections(T, [{ provider: "OPENAI", model: "gpt-4o" }]),
    ).rejects.not.toThrow(LOCAL_DEFAULT_CLOUD_BLOCKED_MESSAGE);
  });
});
