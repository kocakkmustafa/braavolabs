import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as any[],
  pipelines: [] as any[],
  runs: [] as any[],
  tenants: [] as any[],
  seq: 0,
}));

const prismaMock = vi.hoisted(() => ({
  holdingSentinelEvent: {
    findMany: vi.fn(async ({ where }: any) => state.events.filter((e) => e.status === where.status)),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const rows = state.events.filter((e) => where.id.in.includes(e.id));
      rows.forEach((e) => Object.assign(e, data));
      return { count: rows.length };
    }),
  },
  tenant: {
    upsert: vi.fn(async ({ where, create }: any) => {
      const existing = state.tenants.find((t) => t.slug === where.slug);
      if (existing) return existing;
      const tenant = { id: `ten_${++state.seq}`, ...create };
      state.tenants.push(tenant);
      return tenant;
    }),
  },
  pipeline: {
    findFirst: vi.fn(async ({ where }: any) =>
      state.pipelines.find((p) => p.name === where.name && p.tenantId === where.company.tenantId) ?? null,
    ),
  },
  run: {
    create: vi.fn(async ({ data }: any) => {
      const run = { id: `prun_${++state.seq}`, status: "PENDING", output: null, ...data };
      state.runs.push(run);
      return run;
    }),
    findUnique: vi.fn(async ({ where }: any) => state.runs.find((r) => r.id === where.id) ?? null),
  },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

const enqueueRunMock = vi.hoisted(() => vi.fn(async () => "job_1"));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: enqueueRunMock }));
// sensors.ts'in transit bağımlılıkları (queue→redis, telegram→env) test
// ortamında gerçek modül yüklemesin — classify yalnız classifyMail kullanır.
vi.mock("../../../lib/queue", () => ({ holdingRunQueue: { getJobCounts: vi.fn() } }));
vi.mock("../telegram", () => ({ sendSev0Alert: vi.fn(async () => {}) }));
vi.mock("../../../config/env", () => ({ env: { HOLDING_ENABLED: true } }));

import { executeExtendedStep, ExtendedStepError } from "../kinds";

beforeEach(() => {
  state.events.length = 0;
  state.pipelines.length = 0;
  state.runs.length = 0;
  state.tenants.length = 0;
  enqueueRunMock.mockClear();
});

describe("classify kind", () => {
  it("classifies mail deterministically — advisor katmanı YOK (2026-08-07)", async () => {
    const out = await executeExtendedStep(
      { name: "sınıflandır", kind: "classify", reasoning: "test", params: {} },
      { mail: { from: "noreply@apple.com", subject: "Burun Farkı has been rejected" } },
    );
    expect((out.signal as any).severity).toBe("SEV1");
    // Fable Mental danışman öneri katmanı kurucu kararıyla kaldırıldı:
    // eskalasyon artık sinyalin kendisiyle gider, "hangi danışmana sor" eki üretilmez.
    expect(out.onerilen_danisman).toBeUndefined();
    expect(Object.keys(out)).toEqual(["signal"]);
  });

  it("ESCALATES on an unknown mode instead of guessing (DNA 7)", async () => {
    await expect(
      executeExtendedStep({ name: "x", kind: "classify", reasoning: "t", params: { mode: "sentiment" } }, {}),
    ).rejects.toBeInstanceOf(ExtendedStepError);
  });

  it("fails closed on a malformed mail input", async () => {
    await expect(
      executeExtendedStep({ name: "x", kind: "classify", reasoning: "t", params: {} }, { mail: { from: "" } }),
    ).rejects.toBeInstanceOf(ExtendedStepError);
  });
});

describe("patrol kind", () => {
  it("summarizes NEW events, marks them CLASSIFIED, NEVER touches severity", async () => {
    state.events.push(
      { id: "e1", status: "NEW", severity: "SEV1", kind: "store-apple-rejection", createdAt: new Date() },
      { id: "e2", status: "NEW", severity: "SEV1", kind: "store-apple-rejection", createdAt: new Date() },
      { id: "e3", status: "NEW", severity: "INFO", kind: "story_candidate", createdAt: new Date() },
      { id: "e4", status: "ESCALATED", severity: "SEV0", kind: "spend-rate-freeze", createdAt: new Date() },
    );
    const out = await executeExtendedStep({ name: "tara", kind: "patrol", reasoning: "t" }, {});
    expect(out.scanned).toBe(3); // ESCALATED'e dokunmaz
    expect((out.summary as any)["SEV1:store-apple-rejection"]).toBe(2);
    expect(state.events.filter((e) => e.status === "CLASSIFIED")).toHaveLength(3);
    expect(state.events.find((e) => e.id === "e1")!.severity).toBe("SEV1"); // severity aynı
    expect(state.events.find((e) => e.id === "e4")!.status).toBe("ESCALATED");
  });
});

describe("pipeline kind (dogfood köprüsü)", () => {
  it("rejects a missing YULA pipeline with a clear D5 pointer", async () => {
    await expect(
      executeExtendedStep({ name: "p", kind: "pipeline", reasoning: "t", params: { pipelineKey: "yok-boyle-hat" } }, {}),
    ).rejects.toThrow(/D5/);
  });

  it("creates a product run in the YULA tenant, enqueues it and reports the terminal status", async () => {
    // Tenant, upsert ile içeride oluşacak; pipeline'ı ona bağlamak için önce tenant'ı kur.
    const tenant = await prismaMock.tenant.upsert({ where: { slug: "yula-internal" }, create: { name: "YULA Holding", slug: "yula-internal" }, update: {} });
    state.pipelines.push({ id: "pl_1", name: "yula-daily-brief", tenantId: tenant.id });
    // İkinci poll'da COMPLETED görünsün.
    let calls = 0;
    prismaMock.run.findUnique.mockImplementation(async ({ where }: any) => {
      const run = state.runs.find((r) => r.id === where.id)!;
      calls += 1;
      return calls >= 2 ? { ...run, status: "COMPLETED", output: { ok: true } } : run;
    });

    const out = await executeExtendedStep(
      { name: "topla", kind: "pipeline", reasoning: "t", params: { pipelineKey: "yula-daily-brief" } },
      {},
      { pollMs: 1 },
    );
    expect(enqueueRunMock).toHaveBeenCalledOnce();
    expect(out.status).toBe("COMPLETED");
    expect(state.runs[0].trigger).toBe("holding");
  });

  it("hands over to product surfaces when the product run waits for approval", async () => {
    const tenant = await prismaMock.tenant.upsert({ where: { slug: "yula-internal" }, create: { name: "YULA Holding", slug: "yula-internal" }, update: {} });
    state.pipelines.push({ id: "pl_2", name: "yula-content-draft", tenantId: tenant.id });
    prismaMock.run.findUnique.mockImplementation(async ({ where }: any) => ({
      ...state.runs.find((r) => r.id === where.id)!,
      status: "WAITING_APPROVAL",
    }));
    const out = await executeExtendedStep(
      { name: "taslak", kind: "pipeline", reasoning: "t", params: { pipelineKey: "yula-content-draft" } },
      {},
      { pollMs: 1 },
    );
    expect(out.status).toBe("WAITING_APPROVAL");
    expect(String(out.note)).toContain("dogfood");
  });
});
