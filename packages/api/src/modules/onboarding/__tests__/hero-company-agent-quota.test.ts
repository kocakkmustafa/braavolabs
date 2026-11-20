/** BRA-ADAY-9: a real batch creator (onboarding hero-company) writes nothing when the agent quota refuses (402). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const h = vi.hoisted(() => ({
  env: { AGENT_QUOTA_ENABLED: true },
  tx: {} as Record<string, unknown>,
  companyCreate: vi.fn(),
  agentCreate: vi.fn(),
  pipelineCreate: vi.fn(),
  activityCreate: vi.fn(),
  agentCount: vi.fn(),
}));
vi.mock("../../../config/env", () => ({ env: h.env }));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../lib/db", () => ({
  prisma: {},
  tenantTx: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.tx),
}));
vi.mock("../../company/company-capacity", () => ({ assertCompanyCapacity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../company/owner-seed", () => ({ seedCreatorAsOwner: vi.fn() }));
vi.mock("../../billing/entitlement-ledger.service", () => ({ getEffectivePlan: vi.fn().mockResolvedValue("INDIVIDUAL") }));

import { AGENT_QUOTA_BY_PLAN } from "../../company/agent-capacity";
import { onboardingRouter } from "../router";

function handlerFor(router: Router, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env.AGENT_QUOTA_ENABLED = true;
  h.tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ plan: "INDIVIDUAL" }]),
    agent: { count: h.agentCount, create: h.agentCreate },
    company: { create: h.companyCreate },
    pipeline: { create: h.pipelineCreate },
    activityLog: { create: h.activityCreate },
    entitlementEvent: { findMany: vi.fn().mockResolvedValue([]) },
  };
});

async function run() {
  let err: any;
  const res: any = { status() { return this; }, json() { return this; } };
  await handlerFor(onboardingRouter, "/hero-company")(
    { auth: { tenantId: "t1", userId: "u1", role: "admin" }, params: {}, query: {}, body: {} },
    res,
    (e?: unknown) => { err = e; },
  );
  return err;
}

describe("POST /onboarding/hero-company with the agent quota ON", () => {
  it("quota would be exceeded by the 2 agents -> 402 and no company, agent, pipeline or log is written", async () => {
    AGENT_QUOTA_BY_PLAN.INDIVIDUAL = 5;
    try {
      h.agentCount.mockResolvedValue(4); // 4 + 2 > 5
      const err = await run();
      expect(err).toMatchObject({ statusCode: 402, code: "AGENT_LIMIT_REACHED" });
      expect(h.companyCreate).not.toHaveBeenCalled();
      expect(h.agentCreate).not.toHaveBeenCalled();
      expect(h.pipelineCreate).not.toHaveBeenCalled();
      expect(h.activityCreate).not.toHaveBeenCalled();
    } finally {
      delete AGENT_QUOTA_BY_PLAN.INDIVIDUAL;
    }
  });
});
