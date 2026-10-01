import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const queryRaw = vi.hoisted(() => vi.fn());
const companyCount = vi.hoisted(() => vi.fn());
const companyCreate = vi.hoisted(() => vi.fn());
const agentCreate = vi.hoisted(() => vi.fn());
const pipelineCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => {
  const tx = {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    company: {
      create: (...args: unknown[]) => companyCreate(...args),
      findFirst: vi.fn().mockResolvedValue(null),
      count: (...args: unknown[]) => companyCount(...args),
    },
    agent: { create: (...args: unknown[]) => agentCreate(...args) },
    pipeline: { create: (...args: unknown[]) => pipelineCreate(...args) },
    activityLog: { create: (...args: unknown[]) => activityLogCreate(...args) },
    companyTemplate: { update: vi.fn() },
    templateInstall: { create: vi.fn() },
  };
  return {
    prisma: {
      company: { findMany: vi.fn(), findFirst: vi.fn() },
      tenant: { findUnique: vi.fn() },
    },
    tenantTx: (fn: (client: typeof tx) => unknown) => fn(tx),
  };
});
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { companyRouter } from "../router";
import { starterRouter } from "../../starter/starter.router";
import { STARTER_TEMPLATE_IDS } from "../../starter/starter-templates";
import { onboardingRouter } from "../../onboarding/router";
import { materialiseTemplate } from "../../templates/templates.service";

function handler(router: Router, path: string) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods.post);
  if (!layer) throw new Error(`Missing POST ${path}`);
  return layer.route.stack.at(-1).handle;
}

async function invoke(route: ReturnType<typeof handler>, body: unknown, params = {}) {
  const res = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
  };
  let error: unknown;
  await route({ auth: { tenantId: "tenant-1", userId: "user-1" }, body, params }, res, (err: unknown) => { error = err; });
  return { res, error };
}

async function attempt(entryPoint: string) {
  if (entryPoint === "company") {
    return invoke(handler(companyRouter, "/"), {
      name: "Test", slug: "test", primitives: ["CONTENT"],
    });
  }
  if (entryPoint === "starter") {
    return invoke(handler(starterRouter, "/:id/clone"), {}, { id: STARTER_TEMPLATE_IDS[0] });
  }
  if (entryPoint === "onboarding") {
    return invoke(handler(onboardingRouter, "/hero-company"), { companyName: "Test" });
  }
  try {
    const result = await materialiseTemplate("template-1", "tenant-1", {
      name: "Test", description: null, primitives: ["CONTENT"],
      agents: [], pipelines: [], memorySeeds: [],
    });
    return { result, error: undefined };
  } catch (error) {
    return { error };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ plan: "MANUAL_REVIEW" }]);
  companyCount.mockResolvedValue(0);
  companyCreate.mockResolvedValue({ id: "co-1", name: "Test", slug: "test" });
  agentCreate.mockResolvedValue({ id: "agent-1" });
  pipelineCreate.mockResolvedValue({ id: "pipeline-1" });
  activityLogCreate.mockResolvedValue({});
});

describe("company creation entry points", () => {
  it("POST /companies rejects before creating a company or activity", async () => {
    const { error } = await invoke(handler(companyRouter, "/"), {
      name: "Test", slug: "test", primitives: ["CONTENT"],
    });
    expect(error).toMatchObject({ statusCode: 402 });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(companyCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
    expect(companyCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("starter clone rejects before company, agent, pipeline or activity writes", async () => {
    const { error } = await invoke(handler(starterRouter, "/:id/clone"), {}, { id: STARTER_TEMPLATE_IDS[0] });
    expect(error).toMatchObject({ statusCode: 402 });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(companyCreate).not.toHaveBeenCalled();
    expect(agentCreate).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("onboarding rejects before company, agent, pipeline or activity writes", async () => {
    const { error } = await invoke(handler(onboardingRouter, "/hero-company"), { companyName: "Test" });
    expect(error).toMatchObject({ statusCode: 402 });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(companyCreate).not.toHaveBeenCalled();
    expect(agentCreate).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("marketplace materialisation rejects before any install writes", async () => {
    await expect(materialiseTemplate("template-1", "tenant-1", {
      name: "Test", description: null, primitives: ["CONTENT"],
      agents: [], pipelines: [], memorySeeds: [],
    })).rejects.toMatchObject({ statusCode: 402 });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(companyCreate).not.toHaveBeenCalled();
    expect(agentCreate).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it.each(["company", "starter", "onboarding", "marketplace"])(
    "accepts %s at the last INDIVIDUAL slot",
    async (entryPoint) => {
      queryRaw.mockResolvedValue([{ plan: "INDIVIDUAL" }]);
      companyCount.mockResolvedValue(4);
      const response = await attempt(entryPoint);
      expect(response.error).toBeUndefined();
      expect(companyCreate).toHaveBeenCalledOnce();
    },
  );

  it.each(["company", "starter", "onboarding", "marketplace"])(
    "rejects %s after the fifth INDIVIDUAL company without writes",
    async (entryPoint) => {
      queryRaw.mockResolvedValue([{ plan: "INDIVIDUAL" }]);
      companyCount.mockResolvedValue(5);
      const response = await attempt(entryPoint);
      expect(response.error).toMatchObject({ statusCode: 402 });
      expect(companyCreate).not.toHaveBeenCalled();
      expect(agentCreate).not.toHaveBeenCalled();
      expect(pipelineCreate).not.toHaveBeenCalled();
      expect(activityLogCreate).not.toHaveBeenCalled();
    },
  );
});
