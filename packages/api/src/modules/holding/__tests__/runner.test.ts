import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P3 acceptance proof (MOTOR-KICKOFF): a deterministic workflow runs end to
 * end against a stateful in-memory store — every step leaves an audit trail,
 * an approval step parks the run, a founder decision resumes or cancels it,
 * and the policy/cost gates fire at creation. No network, no clock deps.
 */

const state = vi.hoisted(() => ({
  definitions: [] as any[],
  runs: [] as any[],
  stepRuns: [] as any[],
  approvals: [] as any[],
  audits: [] as any[],
  jobs: [] as any[],
  seq: 0,
}));

const prismaMock = vi.hoisted(() => {
  const byId = (rows: any[]) => (id: string) => rows.find((r) => r.id === id);
  return {
    holdingWorkflowDefinition: {
      findUnique: vi.fn(async ({ where }: any) =>
        state.definitions.find((d) => d.key === where.key || d.id === where.id) ?? null,
      ),
    },
    holdingWorkflowRun: {
      create: vi.fn(async ({ data }: any) => {
        const run = { id: `run_${++state.seq}`, resumeCursor: null, startedAt: null, ...data };
        state.runs.push(run);
        return run;
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const run = byId(state.runs)(where.id);
        if (!run) return null;
        if (include?.definition) {
          return { ...run, definition: state.definitions.find((d) => d.id === run.definitionId) };
        }
        return run;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        state.runs.filter((r) => (where?.status?.in ? where.status.in.includes(r.status) : true)),
      ),
      update: vi.fn(async ({ where, data }: any) => Object.assign(byId(state.runs)(where.id), data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.runs.filter(
          (r) => r.id === where.id && (where.status === undefined || r.status === where.status),
        );
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
    },
    holdingStepRun: {
      create: vi.fn(async ({ data }: any) => {
        const stepRun = { id: `step_${++state.seq}`, ...data };
        state.stepRuns.push(stepRun);
        return stepRun;
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(byId(state.stepRuns)(where.id), data)),
    },
    holdingApproval: {
      create: vi.fn(async ({ data }: any) => {
        const approval = { id: `appr_${++state.seq}`, status: "PENDING", runId: null, ...data };
        state.approvals.push(approval);
        return approval;
      }),
      findUnique: vi.fn(async ({ where }: any) => byId(state.approvals)(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => Object.assign(byId(state.approvals)(where.id), data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.approvals.filter(
          (a) => a.id === where.id && (where.status === undefined || a.status === where.status),
        );
        rows.forEach((a) => Object.assign(a, data));
        return { count: rows.length };
      }),
    },
    holdingAuditLog: {
      create: vi.fn(async ({ data }: any) => {
        state.audits.push(data);
        return data;
      }),
    },
  };
});

const queueMock = vi.hoisted(() => ({
  add: vi.fn(async (name: string, data: any, opts: any) => {
    state.jobs.push({ name, data, opts });
  }),
}));
const createWorkerMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));
vi.mock("../../../lib/queue", () => ({
  holdingRunQueue: queueMock,
  createWorker: createWorkerMock,
}));
vi.mock("../telegram", () => ({
  sendApprovalRequest: vi.fn(async () => null),
}));
// kinds.ts, ürün pipeline runner'ını (ağır bağımlılık zinciri) çeker — bu
// suite çekirdek runner'ı izole test eder; extended kind'lar kinds.test'te.
vi.mock("../kinds", () => ({
  executeExtendedStep: vi.fn(async () => ({ mocked: true })),
}));
const preflightMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, softAlert: false })));
vi.mock("../cost-guard", () => ({ preflight: preflightMock }));
const envMock = vi.hoisted(() => ({ HOLDING_ENABLED: true }));
vi.mock("../../../config/env", () => ({ env: envMock }));

import {
  createHoldingRun,
  processHoldingRun,
  resolveHoldingApproval,
  reconcileOrphanHoldingRuns,
  HoldingRunRejected,
} from "../runner";
import type { HoldingCharter } from "../types";

const charter: HoldingCharter = {
  goal: "Deterministik golden-path kanıtı",
  successCriteria: ["3 adımın 3'ü SUCCEEDED"],
  constraints: [],
  riskClass: "R1",
  sources: ["doc:holding/plans/MOTOR-KICKOFF-2026-07-26.md"],
  estCostUsd: 0,
};

function seedDefinition(overrides: Partial<any> = {}) {
  const definition = {
    id: `def_${++state.seq}`,
    key: "gp-smoke",
    name: "GP smoke",
    riskClass: "R1",
    autonomyLevel: 2,
    enabled: true,
    steps: [
      { name: "hazırlık", kind: "noop", reasoning: "durum tespiti" },
      { name: "kayıt", kind: "log", reasoning: "iz bırak", params: { message: "merhaba" } },
      { name: "kapanış", kind: "noop", reasoning: "toparla" },
    ],
    ...overrides,
  };
  state.definitions.push(definition);
  return definition;
}

/** Drain: run every queued job in FIFO order until the queue is empty. */
async function drainJobs() {
  while (state.jobs.length > 0) {
    const job = state.jobs.shift();
    await processHoldingRun({
      data: job.data,
      attemptsMade: 0,
      opts: { attempts: job.opts.attempts },
    } as any);
  }
}

beforeEach(() => {
  for (const key of ["definitions", "runs", "stepRuns", "approvals", "audits", "jobs"] as const) {
    state[key].length = 0;
  }
  preflightMock.mockClear();
  preflightMock.mockResolvedValue({ ok: true, softAlert: false });
  envMock.HOLDING_ENABLED = true;
});

describe("createHoldingRun gates", () => {
  it("rejects every run while the module is dormant", async () => {
    seedDefinition();
    envMock.HOLDING_ENABLED = false;
    await expect(
      createHoldingRun({ definitionKey: "gp-smoke", charter, trustLevel: "TRUSTED", venture: "holding" }),
    ).rejects.toThrow(/dormant/);
    expect(state.runs).toHaveLength(0);
    expect(state.jobs).toHaveLength(0);
  });

  it("rejects an unknown definition", async () => {
    await expect(
      createHoldingRun({ definitionKey: "yok", charter, trustLevel: "TRUSTED", venture: "holding" }),
    ).rejects.toBeInstanceOf(HoldingRunRejected);
  });

  it("rejects a charter that fails K0 lint", async () => {
    seedDefinition();
    await expect(
      createHoldingRun({
        definitionKey: "gp-smoke",
        charter: { ...charter, sources: [] },
        trustLevel: "TRUSTED",
        venture: "holding",
      }),
    ).rejects.toThrow(/K0 lint/);
  });

  it("rejects a charter whose riskClass disagrees with the definition", async () => {
    seedDefinition({ riskClass: "R2" });
    await expect(
      createHoldingRun({ definitionKey: "gp-smoke", charter, trustLevel: "TRUSTED", venture: "holding" }),
    ).rejects.toThrow(/riskClass/);
  });

  it("rejects untagged runs (venture attribution is mandatory)", async () => {
    seedDefinition();
    await expect(
      createHoldingRun({ definitionKey: "gp-smoke", charter, trustLevel: "TRUSTED", venture: "  " }),
    ).rejects.toThrow(/venture/);
  });

  it("blocks when the cost guard says no, with an audit trace", async () => {
    seedDefinition();
    preflightMock.mockResolvedValue({ ok: false, reason: "frozen" });
    await expect(
      createHoldingRun({ definitionKey: "gp-smoke", charter, trustLevel: "TRUSTED", venture: "holding" }),
    ).rejects.toThrow(/frozen/);
    expect(state.audits.some((a) => a.action === "holding.run_cost_blocked")).toBe(true);
  });

  it("parks an R4 run for founder approval instead of enqueueing", async () => {
    seedDefinition({ key: "deploy", riskClass: "R4", autonomyLevel: 5 });
    const run = await createHoldingRun({
      definitionKey: "deploy",
      charter: { ...charter, riskClass: "R4" },
      trustLevel: "TRUSTED",
      venture: "braavolabs",
    });
    expect(run.status).toBe("WAITING_APPROVAL");
    expect(state.jobs).toHaveLength(0);
    expect(state.approvals).toHaveLength(1);
    expect(state.audits.some((a) => a.action === "holding.approval_requested")).toBe(true);
  });
});

describe("end-to-end deterministic golden path", () => {
  it("R1 run executes all steps with a full audit trail", async () => {
    seedDefinition();
    const run = await createHoldingRun({
      definitionKey: "gp-smoke",
      charter,
      trustLevel: "TRUSTED",
      venture: "holding",
    });
    expect(run.status).toBe("PENDING");
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0].opts.jobId).toBe(`${run.id}:0`);

    await drainJobs();

    const finished = state.runs[0];
    expect(finished.status).toBe("SUCCEEDED");
    expect(state.stepRuns).toHaveLength(3);
    expect(state.stepRuns.every((s) => s.status === "SUCCEEDED")).toBe(true);
    // Audit: created + 3 × step_completed + succeeded — izi audit'te.
    expect(state.audits.filter((a) => a.action === "holding.step_completed")).toHaveLength(3);
    expect(state.audits.some((a) => a.action === "holding.run_succeeded")).toBe(true);
    // Every step carries its mandatory reasoning.
    expect(state.stepRuns.every((s) => typeof s.reasoning === "string" && s.reasoning.length > 0)).toBe(true);
  });

  it("an approval step parks the run; APPROVED resumes AFTER the gate", async () => {
    seedDefinition({
      key: "gated",
      steps: [
        { name: "hazırlık", kind: "noop", reasoning: "ön koşul" },
        { name: "kurucu kapısı", kind: "approval", reasoning: "R2 dış etki", params: { description: "Onaylıyor musun?" } },
        { name: "uygula", kind: "log", reasoning: "onay sonrası iş" },
      ],
    });
    const run = await createHoldingRun({
      definitionKey: "gated",
      charter,
      trustLevel: "TRUSTED",
      venture: "holding",
    });
    await drainJobs();

    expect(state.runs[0].status).toBe("WAITING_APPROVAL");
    expect(state.runs[0].resumeCursor).toBe(2); // resumes AFTER the gate
    const approval = state.approvals.find((a) => a.stepIndex === 1);
    expect(approval?.status).toBe("PENDING");

    const res = await resolveHoldingApproval({
      approvalId: approval.id,
      decision: "APPROVED",
      decidedBy: "telegram:42",
    });
    expect(res.ok).toBe(true);
    expect(state.jobs.at(-1)?.opts.jobId).toBe(`${run.id}:2`);
    await drainJobs();

    expect(state.runs[0].status).toBe("SUCCEEDED");
    // The pre-gate step ran exactly once (idempotent resume).
    expect(state.stepRuns.filter((s) => s.name === "hazırlık")).toHaveLength(1);
    expect(state.stepRuns.filter((s) => s.name === "uygula")).toHaveLength(1);
  });

  it("REJECTED cancels the run and never executes the gated step", async () => {
    seedDefinition({
      key: "gated2",
      steps: [
        { name: "kapı", kind: "approval", reasoning: "kurucu kararı" },
        { name: "uygula", kind: "log", reasoning: "onay sonrası" },
      ],
    });
    await createHoldingRun({ definitionKey: "gated2", charter, trustLevel: "TRUSTED", venture: "holding" });
    await drainJobs();

    const approval = state.approvals[0];
    await resolveHoldingApproval({ approvalId: approval.id, decision: "REJECTED", decidedBy: "telegram:42" });

    expect(state.runs[0].status).toBe("CANCELLED");
    expect(state.jobs).toHaveLength(0);
    expect(state.stepRuns.find((s) => s.name === "uygula")).toBeUndefined();
    expect(state.audits.some((a) => a.action === "holding.run_cancelled")).toBe(true);
  });

  it("a second decision on the same approval is a no-op replay", async () => {
    seedDefinition({
      key: "gated3",
      steps: [{ name: "kapı", kind: "approval", reasoning: "kurucu kararı" }],
    });
    await createHoldingRun({ definitionKey: "gated3", charter, trustLevel: "TRUSTED", venture: "holding" });
    await drainJobs();
    const approval = state.approvals[0];

    await resolveHoldingApproval({ approvalId: approval.id, decision: "APPROVED", decidedBy: "telegram:42" });
    const replay = await resolveHoldingApproval({ approvalId: approval.id, decision: "REJECTED", decidedBy: "telegram:99" });

    expect(replay.ok).toBe(false);
    expect(state.approvals[0].status).toBe("APPROVED"); // first decision wins
    expect(state.audits.some((a) => a.action === "holding.approval_replay_ignored")).toBe(true);
  });

  it("reconciliation re-enqueues stranded PENDING/RUNNING runs only", async () => {
    seedDefinition();
    const run = await createHoldingRun({
      definitionKey: "gp-smoke",
      charter,
      trustLevel: "TRUSTED",
      venture: "holding",
    });
    // Simulate the crash window: job lost after the DB write.
    state.jobs.length = 0;
    const count = await reconcileOrphanHoldingRuns();
    expect(count).toBe(1);
    expect(state.jobs[0].opts.jobId).toBe(`${run.id}:0`);
    // Terminal runs are never re-enqueued.
    state.runs[0].status = "SUCCEEDED";
    state.jobs.length = 0;
    expect(await reconcileOrphanHoldingRuns()).toBe(0);
    expect(state.jobs).toHaveLength(0);
  });

  it("stale jobs against a parked/terminal run are ignored", async () => {
    seedDefinition({ key: "gated4", steps: [{ name: "kapı", kind: "approval", reasoning: "kapı" }] });
    const run = await createHoldingRun({ definitionKey: "gated4", charter, trustLevel: "TRUSTED", venture: "holding" });
    await drainJobs();
    expect(state.runs[0].status).toBe("WAITING_APPROVAL");

    // A duplicated/stale job must not touch the parked run.
    await processHoldingRun({ data: { runId: run.id }, attemptsMade: 0, opts: { attempts: 3 } } as any);
    expect(state.runs[0].status).toBe("WAITING_APPROVAL");
    expect(state.approvals).toHaveLength(1);
  });
});
