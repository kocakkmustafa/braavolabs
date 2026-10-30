/**
 * B-06 — the voice agent (create + outbound dial, REST and agent tool) stays
 * OFF on the server until VOICE_AGENT_ENABLED=true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const companyFindFirst = vi.hoisted(() => vi.fn());
const voiceAgentCreate = vi.hoisted(() => vi.fn());
const voiceAgentFindFirst = vi.hoisted(() => vi.fn());
const voiceAgentFindMany = vi.hoisted(() => vi.fn());
const voiceAgentDelete = vi.hoisted(() => vi.fn());
const voiceCallCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const providerPlaceCall = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    agent: { findFirst: vi.fn() },
    voiceAgent: {
      create: (...a: unknown[]) => voiceAgentCreate(...a),
      findFirst: (...a: unknown[]) => voiceAgentFindFirst(...a),
      findMany: (...a: unknown[]) => voiceAgentFindMany(...a),
      delete: (...a: unknown[]) => voiceAgentDelete(...a),
    },
    voiceCall: { create: (...a: unknown[]) => voiceCallCreate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));
vi.mock("../../../lib/redis", () => ({ redis: {} }));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../providers/vapi", () => ({
  vapiAdapter: { placeOutboundCall: (...a: unknown[]) => providerPlaceCall(...a) },
}));

import { voiceRouter } from "../voice.router";
import { placeOutboundCall } from "../voice.service";

function handler(method: "get" | "post" | "delete", path: string) {
  const layer = (voiceRouter as Router & { stack: any[] }).stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`Voice ${method} ${path} missing`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: (error?: any) => void) => Promise<void>;
}

async function invoke(
  method: "get" | "post" | "delete",
  path: string,
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), json };
  let error: any;
  await handler(method, path)(
    { params, body, query: {}, auth: { tenantId: "tenant-1", userId: "user-1" } },
    res,
    (nextError?: any) => { error = nextError; },
  );
  return { res, json, error };
}

const agentBody = { companyId: "company-1", name: "Front desk", provider: "VAPI" };
const dialBody = { calleeNumber: "+14155550101", prompt: "Confirm the appointment." };
const voiceAgent = {
  id: "va-1",
  isActive: true,
  outboundPerHour: null,
  provider: "VAPI",
  phoneNumber: "+14155550100",
  voiceConfig: {},
  company: { tenantId: "tenant-1" },
};

function expectNoDialSideEffects() {
  expect(voiceAgentFindFirst).not.toHaveBeenCalled();
  expect(providerPlaceCall).not.toHaveBeenCalled();
  expect(voiceCallCreate).not.toHaveBeenCalled();
  expect(activityLogCreate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  companyFindFirst.mockResolvedValue({ id: "company-1" });
  voiceAgentCreate.mockResolvedValue({ id: "va-1" });
  voiceAgentFindFirst.mockResolvedValue(voiceAgent);
  voiceAgentFindMany.mockResolvedValue([voiceAgent]);
  voiceAgentDelete.mockResolvedValue({});
  voiceCallCreate.mockResolvedValue({ id: "call-1" });
  activityLogCreate.mockResolvedValue({});
  providerPlaceCall.mockResolvedValue({ providerCallId: "prov-1" });
  vi.stubEnv("VOICE_AGENT_ENABLED", "false");
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("voice API — B-06 gate", () => {
  it.each([undefined, "false", "1"])("VOICE_AGENT_ENABLED=%s refuses agent creation with 422", async (value) => {
    if (value === undefined) delete process.env.VOICE_AGENT_ENABLED;
    else vi.stubEnv("VOICE_AGENT_ENABLED", value);
    const { error, json } = await invoke("post", "/agents", agentBody);
    expect(error).toMatchObject({ statusCode: 422, code: "VOICE_AGENT_DISABLED" });
    expect(json).not.toHaveBeenCalled();
    expect(companyFindFirst).not.toHaveBeenCalled();
    expect(voiceAgentCreate).not.toHaveBeenCalled();
  });

  it("refuses outbound dial with 422 before any lookup, provider call or write", async () => {
    const { error, json } = await invoke("post", "/agents/:id/dial", dialBody, { id: "va-1" });
    expect(error).toMatchObject({ statusCode: 422, code: "VOICE_AGENT_DISABLED" });
    expect(json).not.toHaveBeenCalled();
    expectNoDialSideEffects();
  });

  it("refuses the service path used by the make_outbound_call tool", async () => {
    await expect(placeOutboundCall({
      voiceAgentId: "va-1",
      tenantId: "tenant-1",
      calleeNumber: "+14155550101",
      prompt: "Confirm the appointment.",
    })).rejects.toMatchObject({ statusCode: 422, code: "VOICE_AGENT_DISABLED" });
    expectNoDialSideEffects();
  });

  it("keeps listing and deleting existing voice agents available", async () => {
    const listed = await invoke("get", "/agents");
    expect(listed.error).toBeUndefined();
    expect(listed.json).toHaveBeenCalledWith([voiceAgent]);

    const removed = await invoke("delete", "/agents/:id", {}, { id: "va-1" });
    expect(removed.error).toBeUndefined();
    expect(voiceAgentDelete).toHaveBeenCalledWith({ where: { id: "va-1" } });
  });

  it("restores agent creation and dialing when the flag is \"true\"", async () => {
    vi.stubEnv("VOICE_AGENT_ENABLED", "true");
    const created = await invoke("post", "/agents", agentBody);
    expect(created.error).toBeUndefined();
    expect(created.res.status).toHaveBeenCalledWith(201);
    expect(voiceAgentCreate).toHaveBeenCalledOnce();

    const dialed = await invoke("post", "/agents/:id/dial", dialBody, { id: "va-1" });
    expect(dialed.error).toBeUndefined();
    expect(providerPlaceCall).toHaveBeenCalledOnce();
    expect(dialed.json).toHaveBeenCalledWith({ callId: "call-1", providerCallId: "prov-1", status: "ringing" });
  });
});
