/**
 * E5/T1 — importer persist path writes runnable steps + synthesizes Agents.
 *
 * Router handler is exercised directly (same zero-network harness as
 * pipeline-router-schedule.test.ts). Prisma is mocked; `$transaction(fn)` runs
 * the callback against a `tx` stub so we can assert:
 *   • pipeline.create is called WITH a non-empty `steps` array in executor shape
 *     ({name,agentRole,order}) — closes E5-IMP-01.
 *   • agents are synthesized idempotently (findFirst→create) — closes E5-IMP-02.
 *   • every step.agentRole exact-matches a created (or pre-existing) Agent role.
 *   • DIRTY-BUCKET regression: a pre-existing short-named agent is NOT re-created
 *     and does NOT stop the correct imported_* agents from being created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const companyFindFirst = vi.hoisted(() => vi.fn());
const companyCreate = vi.hoisted(() => vi.fn());
const companyCount = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());
const agentFindFirst = vi.hoisted(() => vi.fn());
const agentCreate = vi.hoisted(() => vi.fn());
const pipelineCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const txRun = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => {
  const tx = {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    company: {
      findFirst: (...a: unknown[]) => companyFindFirst(...a),
      create: (...a: unknown[]) => companyCreate(...a),
      count: (...a: unknown[]) => companyCount(...a),
    },
    agent: { findFirst: (...a: unknown[]) => agentFindFirst(...a), create: (...a: unknown[]) => agentCreate(...a) },
    pipeline: { create: (...a: unknown[]) => pipelineCreate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  };
  return {
    prisma: {
      company: {
        findFirst: (...a: unknown[]) => companyFindFirst(...a),
        create: (...a: unknown[]) => companyCreate(...a),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => {
        txRun();
        return fn(tx);
      },
    },
    // RLS-real: tenantTx behaves like $transaction in tests (fn against tx mock).
    tenantTx: (fn: (t: typeof tx) => unknown) => {
      txRun();
      return fn(tx);
    },
  };
});

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { automationImporterRouter } from "../router";
import { IMPORTED_LLM_ROLE, IMPORTED_OPERATOR_ROLE } from "../agent-synthesis";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any = undefined;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

const handler = getHandler(automationImporterRouter, "post", "/");

// An n8n workflow with an http (→operator) and an llm (→llm) node.
const n8nPayload = JSON.stringify({
  name: "Flow",
  nodes: [
    { id: "a", name: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: { url: "https://x", apiKey: "sk-secret" } },
    { id: "b", name: "Reason", type: "@n8n/n8n-nodes-langchain.lmChatAnthropic", parameters: {} },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  companyFindFirst.mockResolvedValue({ id: "co-1", tenantId: "tenant-1" });
  companyCount.mockResolvedValue(0);
  queryRaw.mockResolvedValue([{ id: "tenant-1", plan: "MANUAL_REVIEW" }]);
  companyCreate.mockResolvedValue({ id: "bucket-1" });
  pipelineCreate.mockResolvedValue({ id: "pipe-1" });
  activityLogCreate.mockResolvedValue({});
  agentCreate.mockResolvedValue({});
});

describe("importer persist — steps + agents", () => {
  it("persists non-empty steps in executor shape and synthesizes both agents", async () => {
    agentFindFirst.mockResolvedValue(null); // no pre-existing agents

    const { res, nextErr } = await invoke(handler, {
      body: { source: "n8n", payload: n8nPayload, companyId: "co-1" },
    });

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(txRun).toHaveBeenCalled();

    // pipeline.create got a non-empty steps array in executor shape
    const createArg = pipelineCreate.mock.calls[0][0];
    const steps = createArg.data.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(2);
    for (const s of steps) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.order).toBe("number");
      expect([IMPORTED_LLM_ROLE, IMPORTED_OPERATOR_ROLE]).toContain(s.agentRole);
    }
    expect(steps[0].agentRole).toBe(IMPORTED_OPERATOR_ROLE); // http
    expect(steps[1].agentRole).toBe(IMPORTED_LLM_ROLE); // llm

    // both fixed-role agents created
    const createdRoles = agentCreate.mock.calls.map((c) => c[0].data.role).sort();
    expect(createdRoles).toEqual([IMPORTED_LLM_ROLE, IMPORTED_OPERATOR_ROLE]);
    // each synthesized agent has a non-empty systemPrompt
    for (const c of agentCreate.mock.calls) {
      expect(c[0].data.systemPrompt.trim().length).toBeGreaterThan(0);
    }

    // every step.agentRole exact-matches a created agent role
    const agentRoles = new Set(agentCreate.mock.calls.map((c) => c[0].data.role));
    for (const s of steps) expect(agentRoles.has(s.agentRole)).toBe(true);
  });

  it("masks secret-like fields in the stored payload/config", async () => {
    agentFindFirst.mockResolvedValue(null);
    await invoke(handler, { body: { source: "n8n", payload: n8nPayload, companyId: "co-1" } });
    const cfg = pipelineCreate.mock.calls[0][0].data.config;
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).toContain("REDACTED");
  });

  it("SECURITY: masks secrets in the RUNNABLE steps column (not just config)", async () => {
    // Regression for the HIGH finding: masking was applied only to the dead
    // config.converted copy while the executor-/API-read `data.steps` column was
    // written UNMASKED, leaking imported apiKey/token/password in plaintext.
    agentFindFirst.mockResolvedValue(null);
    await invoke(handler, { body: { source: "n8n", payload: n8nPayload, companyId: "co-1" } });

    const data = pipelineCreate.mock.calls[0][0].data;
    const steps = data.steps;
    expect(Array.isArray(steps)).toBe(true);

    // No plaintext secret survives anywhere in the persisted steps column …
    const stepsSerialized = JSON.stringify(steps);
    expect(stepsSerialized).not.toContain("sk-secret");

    // … and the secret KEY that carried it is redacted in the step that owned it.
    for (const s of steps) {
      const cfg = (s.config ?? {}) as Record<string, unknown>;
      if ("apiKey" in cfg) {
        expect(cfg.apiKey).not.toBe("sk-secret");
        expect(String(cfg.apiKey)).toContain("REDACTED");
      }
    }

    // The http step specifically carried apiKey: "sk-secret" in the fixture —
    // prove that exact step is now masked (guards against the blind spot where a
    // test passes only because no step actually held the secret).
    const httpStep = steps.find((s: any) => s.sourceType === "http");
    expect(httpStep).toBeDefined();
    expect(String((httpStep.config as any).apiKey)).toContain("REDACTED");
  });

  it("is idempotent — does NOT re-create an already-existing role", async () => {
    // operator already exists, llm does not
    agentFindFirst.mockImplementation(async ({ where }: any) =>
      where.role === IMPORTED_OPERATOR_ROLE ? { id: "op-existing", role: IMPORTED_OPERATOR_ROLE } : null,
    );

    await invoke(handler, { body: { source: "n8n", payload: n8nPayload, companyId: "co-1" } });

    const createdRoles = agentCreate.mock.calls.map((c) => c[0].data.role);
    expect(createdRoles).toEqual([IMPORTED_LLM_ROLE]); // only the missing one
  });

  it("DIRTY-BUCKET: a pre-existing short-named legacy agent does not block synthesis", async () => {
    // Simulate a bucket where a legacy agent named "op"/role "legacy" exists.
    // findFirst is scoped by (companyId, role) so it never returns for the
    // imported_* roles → both are created regardless of the legacy agent.
    agentFindFirst.mockImplementation(async ({ where }: any) => {
      if (where.role === "legacy") return { id: "legacy-1", name: "op", role: "legacy" };
      return null;
    });

    await invoke(handler, { body: { source: "n8n", payload: n8nPayload, companyId: "co-1" } });

    const createdRoles = agentCreate.mock.calls.map((c) => c[0].data.role).sort();
    expect(createdRoles).toEqual([IMPORTED_LLM_ROLE, IMPORTED_OPERATOR_ROLE]);
  });

  it.each([
    ["MANUAL_REVIEW", 0],
    ["INDIVIDUAL", 5],
  ])("does not create a bucket or related rows when %s has %i companies", async (plan, count) => {
    companyFindFirst.mockResolvedValue(null);
    queryRaw.mockResolvedValue([{ id: "tenant-1", plan }]);
    companyCount.mockResolvedValue(count);
    const { nextErr } = await invoke(handler, { body: { source: "n8n", payload: n8nPayload } });
    expect(nextErr).toMatchObject({ statusCode: 402 });
    expect(companyCreate).not.toHaveBeenCalled();
    expect(agentCreate).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
    expect(activityLogCreate).not.toHaveBeenCalled();
  });

  it("creates one bucket at the last INDIVIDUAL slot, then attaches the pipeline to it", async () => {
    companyFindFirst.mockResolvedValue(null);
    queryRaw.mockResolvedValue([{ id: "tenant-1", plan: "INDIVIDUAL" }]);
    companyCount.mockResolvedValue(4);
    agentFindFirst.mockResolvedValue(null);
    const { res, nextErr } = await invoke(handler, { body: { source: "n8n", payload: n8nPayload } });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(companyCreate).toHaveBeenCalledOnce();
    expect(pipelineCreate.mock.calls[0][0].data.companyId).toBe("bucket-1");
  });

  it("reuses an existing bucket even when the tenant has no capacity for another company", async () => {
    agentFindFirst.mockResolvedValue(null);
    const { res, nextErr } = await invoke(handler, { body: { source: "n8n", payload: n8nPayload } });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(companyCreate).not.toHaveBeenCalled();
    expect(companyCount).not.toHaveBeenCalled();
    expect(pipelineCreate.mock.calls[0][0].data.companyId).toBe("co-1");
  });
});
