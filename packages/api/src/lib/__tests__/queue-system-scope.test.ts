import { describe, it, expect, vi, beforeEach } from "vitest";
import { currentTenantContext, currentTenantId } from "../tenant-context";

/**
 * BR-P0-004 slice 2 — every BullMQ worker runs system-scoped.
 *
 * Workers have no request and therefore no tenant context. Marking them at the
 * `createWorker` FACTORY rather than in each worker body means a worker added
 * later inherits the marker automatically — it cannot silently become an
 * unmarked path that the slice-3 fail-closed rule would then reject at
 * runtime, in production, on a queue nobody was watching.
 */
const workerCtor = vi.hoisted(() => vi.fn());
vi.mock("bullmq", () => ({
  Queue: class { constructor(public name: string) {} },
  Worker: class {
    constructor(name: string, processor: any, opts: any) {
      workerCtor(name, processor, opts);
    }
    on() { return this; }
  },
}));
vi.mock("../redis", () => ({ redis: {} }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => workerCtor.mockClear());

describe("createWorker: system scope", () => {
  it("runs the processor inside a system scope named after the queue", async () => {
    const { createWorker } = await import("../queue");
    let seen: unknown;
    createWorker("pipeline-runs", async () => {
      seen = currentTenantContext();
    });

    const registered = workerCtor.mock.calls.at(-1)![1];
    await registered({ id: "job-1" });

    expect(seen).toEqual({ kind: "system", reason: "worker:pipeline-runs" });
  });

  it("keeps currentTenantId undefined inside the processor (behavior preserved)", async () => {
    const { createWorker } = await import("../queue");
    let seen: unknown = "sentinel";
    createWorker("pipeline-schedules", async () => {
      seen = currentTenantId();
    });
    await workerCtor.mock.calls.at(-1)![1]({ id: "job-2" });
    expect(seen).toBeUndefined();
  });

  it("passes the job through and propagates the processor's return value", async () => {
    const { createWorker } = await import("../queue");
    let gotJob: any;
    createWorker("q", async (job: any) => { gotJob = job; });
    await workerCtor.mock.calls.at(-1)![1]({ id: "job-3", data: { runId: "r1" } });
    expect(gotJob).toEqual({ id: "job-3", data: { runId: "r1" } });
  });

  it("lets a processor error propagate so BullMQ still fails/retries the job", async () => {
    const { createWorker } = await import("../queue");
    createWorker("q", async () => { throw new Error("boom"); });
    await expect(workerCtor.mock.calls.at(-1)![1]({ id: "job-4" })).rejects.toThrow("boom");
  });

  it("does not leak the scope after the job finishes", async () => {
    const { createWorker } = await import("../queue");
    createWorker("q", async () => {});
    await workerCtor.mock.calls.at(-1)![1]({ id: "job-5" });
    expect(currentTenantContext()).toBeUndefined();
  });
});
