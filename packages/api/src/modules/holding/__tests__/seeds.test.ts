import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ defs: new Map<string, any>(), audits: [] as any[] }));
const prismaMock = vi.hoisted(() => ({
  holdingWorkflowDefinition: {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = store.defs.get(where.key);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      store.defs.set(where.key, { ...create });
      return create;
    }),
  },
  holdingAuditLog: {
    create: vi.fn(async ({ data }: any) => {
      store.audits.push(data);
      return data;
    }),
  },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

import { seedHoldingDefinitions } from "../seeds";
import workflowSeeds from "../seed-data/workflows.json";

beforeEach(() => {
  store.defs.clear();
  store.audits.length = 0;
});

describe("D4 workflow seed", () => {
  it("loads the FULL governance catalog (28 definitions) with governance-verbatim enabled flags", async () => {
    const result = await seedHoldingDefinitions();
    expect(result.total).toBe(workflowSeeds.length);
    expect(workflowSeeds.length).toBe(31); // governance workflows.yaml v3 ile kilitli
    expect(store.defs.size).toBe(workflowSeeds.length);
    // Dormant-by-design: yalnız duman testi açık doğar.
    expect(result.enabled).toBe(1);
    expect(store.defs.get("kapi-duman-testi")!.enabled).toBe(true);
    expect(store.defs.get("gp1-hikaye-yayini")!.enabled).toBe(false);
    expect(store.audits.some((a) => a.action === "holding.definitions_seeded")).toBe(true);
  });

  it("is idempotent — a re-run converges instead of duplicating", async () => {
    await seedHoldingDefinitions();
    store.defs.get("kapi-duman-testi")!.name = "elle bozulmuş ad";
    await seedHoldingDefinitions();
    expect(store.defs.size).toBe(workflowSeeds.length);
    expect(store.defs.get("kapi-duman-testi")!.name).not.toBe("elle bozulmuş ad"); // dosya kazanır
  });

  it("every seeded definition carries valid steps with closed-set kinds", () => {
    const allowed = new Set(["noop", "log", "approval", "pipeline", "patrol", "classify"]);
    for (const seed of workflowSeeds) {
      expect(seed.steps.length).toBeGreaterThan(0);
      for (const step of seed.steps) {
        expect(allowed.has(step.kind)).toBe(true);
        expect((step as any).reasoning?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
