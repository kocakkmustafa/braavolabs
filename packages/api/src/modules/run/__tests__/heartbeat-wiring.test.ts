/**
 * BRA-P0-04d — beatRun'ın yazıcılara BAĞLI olduğunun kanıtı.
 * writeLifecycle: davranışsal (bayrak açık → RUNNING'te kısıtsız atış; kapalı → DB'ye dokunmaz).
 * runner.ts / hierarchical-runner.ts: kaynak düzeyi bağ denetimi (bu iki dosyanın tam
 * koşusu ağır sahte gerektirir; bağ silinirse bu test kırılır). NOT covered: canlı koşu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const updateMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({ prisma: { run: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));
const transitionRunMock = vi.hoisted(() => vi.fn());
vi.mock("../transition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transition")>();
  return { ...actual, transitionRun: (...a: unknown[]) => transitionRunMock(...a) };
});

import { writeLifecycle } from "../write-lifecycle";
import { resetHeartbeatState, beatRun } from "../heartbeat";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetHeartbeatState();
  updateMany.mockResolvedValue({ count: 1 });
  transitionRunMock.mockResolvedValue({ ok: true, noop: false, from: "READY", to: "RUNNING" });
});

describe("writeLifecycle → heartbeat", () => {
  it("flag off: transition written, heartbeat never touches the DB", async () => {
    await writeLifecycle("r1", "t1", "RUNNING", {});
    expect(transitionRunMock).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("flag on: RUNNING pickup writes a fresh heartbeat even inside the throttle window; FAILED forgets the throttle entry", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    await writeLifecycle("r1", "t1", "RUNNING", {});
    await writeLifecycle("r1", "t1", "RUNNING", {});
    expect(updateMany).toHaveBeenCalledTimes(2); // force bypasses the 30 s window
    expect(updateMany.mock.calls[0][0].data).toHaveProperty("heartbeatAt");
    await beatRun("r1", "t1"); // inside window → throttled
    expect(updateMany).toHaveBeenCalledTimes(2);
    transitionRunMock.mockResolvedValue({ ok: true, noop: false, from: "RUNNING", to: "FAILED" });
    await writeLifecycle("r1", "t1", "FAILED", {});
    expect(await beatRun("r1", "t1")).toBe(true); // entry was forgotten
  });

  it("a heartbeat write error does not break the lifecycle write", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    updateMany.mockRejectedValue(new Error("db down"));
    await expect(writeLifecycle("r1", "t1", "RUNNING", {})).resolves.toBe(true);
  });
});

describe("runner wiring (source-level)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");
  it("sequential runner beats at group start and after each step, and forgets on every exit", () => {
    const src = read("pipeline/runner.ts");
    expect((src.match(/await beatRun\(runId, tenantId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("forgetBeat(job.data.runId)");
    expect(src).toContain('createWorker<RunJobData>("pipeline-runs", processRunTracked)');
  });
  it("hierarchical runner beats around each delegation", () => {
    const src = read("pipeline/hierarchical-runner.ts");
    expect((src.match(/await beatRun\(ctx\.runId, ctx\.tenantId\)/g) ?? []).length).toBe(2);
  });
});
