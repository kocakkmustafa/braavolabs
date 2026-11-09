/**
 * BRA-P0-04d — heartbeat yazıcısı. Bayrak kapalı = hiç sorgu/yazma yok; açık =
 * 30 sn kısıtlı, tenant kapsamlı, yalnız RUNNING satırına; hata koşuyu bozmaz.
 * NOT covered: gerçek Postgres (updateMany sahte).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const updateMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({ prisma: { run: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));

import { beatRun, HEARTBEAT_MIN_INTERVAL_MS, resetHeartbeatState, forgetBeat } from "../heartbeat";
import { jobStaleAfterMs } from "../job-bucket-query";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetHeartbeatState();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("beatRun", () => {
  it("flag off (unset or not literal true): no query, no write", async () => {
    expect(await beatRun("r1", "t1")).toBe(false);
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "1");
    expect(await beatRun("r1", "t1", { force: true })).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("flag on: writes heartbeatAt only to the tenant's RUNNING row", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    expect(await beatRun("r1", "t1", { now: 1_000_000 })).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "r1", status: "RUNNING", pipeline: { company: { tenantId: "t1" } } },
      data: { heartbeatAt: new Date(1_000_000) },
    });
  });

  it("throttles per run: inside the window no second write; after it, one; force bypasses; other runs independent", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    await beatRun("r1", "t1", { now: 0 });
    expect(await beatRun("r1", "t1", { now: HEARTBEAT_MIN_INTERVAL_MS - 1 })).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(await beatRun("r1", "t1", { now: HEARTBEAT_MIN_INTERVAL_MS })).toBe(true);
    expect(await beatRun("r1", "t1", { now: HEARTBEAT_MIN_INTERVAL_MS + 1, force: true })).toBe(true);
    expect(await beatRun("r2", "t1", { now: HEARTBEAT_MIN_INTERVAL_MS + 2 })).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(4);
  });

  it("concurrent parallel-step beats in one window write once", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    await Promise.all([beatRun("r1", "t1", { now: 5 }), beatRun("r1", "t1", { now: 6 }), beatRun("r1", "t1", { now: 7 })]);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("forgetBeat lets the next beat through", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    await beatRun("r1", "t1", { now: 0 });
    forgetBeat("r1");
    expect(await beatRun("r1", "t1", { now: 1 })).toBe(true);
  });

  it("a write error never throws (run is not broken)", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    updateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(beatRun("r1", "t1", { now: 0 })).resolves.toBe(false);
  });

  it("interval stays well under the single-source stale threshold", () => {
    expect(HEARTBEAT_MIN_INTERVAL_MS * 10).toBeLessThan(jobStaleAfterMs());
  });

  it("a failed write does not set the throttle mark (next call retries); a successful one does", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    updateMany.mockRejectedValueOnce(new Error("db down"));
    expect(await beatRun("r1", "t1", { now: 0 })).toBe(false);
    expect(await beatRun("r1", "t1", { now: 1 })).toBe(true);
    expect(await beatRun("r1", "t1", { now: 2 })).toBe(false); // throttled now
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("an already-tracked run is never evicted when the map is full (existing entry keeps its throttle)", async () => {
    vi.stubEnv("JOB_STATE_DUAL_WRITE", "true");
    await beatRun("keep", "t1", { now: 0 });
    for (let i = 0; i < 5_000; i++) await beatRun(`r${i}`, "t1", { now: 0 });
    // "keep" was the oldest and got evicted only when NEW runs arrived; re-beat then refresh must not evict others needlessly
    updateMany.mockClear();
    await beatRun("r4999", "t1", { now: 40_000 }); // existing entry: write, no eviction
    expect(await beatRun("r4999", "t1", { now: 40_001 })).toBe(false);
    expect(await beatRun("r4998", "t1", { now: 1 })).toBe(false); // still tracked and throttled
  });
});
