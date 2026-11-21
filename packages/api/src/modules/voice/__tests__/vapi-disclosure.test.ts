import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/db", () => ({
  prisma: {
    voiceAgent: { findUnique: vi.fn().mockResolvedValue({ companyId: "company-1" }) },
    integration: { findFirst: vi.fn().mockResolvedValue({ credentials: "enc" }) },
  },
}));
vi.mock("../../../lib/encryption", () => ({
  decrypt: () => JSON.stringify({
    apiKey: "synthetic-key",
    defaultAssistantId: "asst-1",
    phoneNumberId: "pn-1",
    endpointUrl: "https://voice.example.test",
  }),
}));
vi.mock("../../../lib/ssrf", () => ({
  assertSafeExternalUrl: vi.fn().mockResolvedValue(undefined),
  SsrfError: class SsrfError extends Error {},
}));
vi.mock("../../../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { vapiAdapter } from "../providers/vapi";
import { customAdapter } from "../providers/custom";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "call-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const voiceAgent = { id: "va-1", voiceConfig: {}, phoneNumber: "+14155550100" };

describe("provider adapters speak the AI disclosure first", () => {
  it("vapi: firstMessage starts with the disclosure and stays within 500 chars", async () => {
    const disclosure = "This is an automated AI assistant calling.";
    await vapiAdapter.placeOutboundCall({
      voiceAgent, calleeNumber: "+14155550101", prompt: "p".repeat(900), disclosure,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const first = body.assistantOverrides.firstMessage as string;
    expect(first.startsWith(disclosure)).toBe(true);
    expect(first.length).toBeLessThanOrEqual(500);
    expect(body.assistantOverrides.variableValues.task).toBe("p".repeat(900));
  });

  it("vapi: a 300-char disclosure is never truncated", async () => {
    const disclosure = "d".repeat(300);
    await vapiAdapter.placeOutboundCall({
      voiceAgent, calleeNumber: "+14155550101", prompt: "task", disclosure,
    });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body).assistantOverrides.firstMessage as string;
    expect(first.startsWith(disclosure)).toBe(true);
  });

  it("custom: sends the disclosure field and forces it to open the prompt", async () => {
    await customAdapter.placeOutboundCall({
      voiceAgent, calleeNumber: "+14155550101", prompt: "Task", disclosure: "AI call.",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.disclosure).toBe("AI call.");
    expect(body.prompt.startsWith('Begin the call by saying exactly: "AI call."')).toBe(true);
    expect(body.prompt.endsWith("Task")).toBe(true);
  });
});
