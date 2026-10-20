import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), duplicate: vi.fn(), buffered: vi.fn() }));
vi.mock("../../../lib/db", () => ({ prisma: { run: { findFirst: m.find } } }));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/redis", () => ({ redis: { duplicate: m.duplicate } }));
vi.mock("../../../lib/runEvents", () => ({ runEventChannel: (id: string) => `run:${id}`, getBufferedRunEvents: m.buffered }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: any, _s: any, n: any) => n() }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../../services/ai-client", () => ({ LOCAL_PROVIDERS: new Set(), chatCompletion: vi.fn(), getTenantAIConfig: vi.fn() }));
vi.mock("../../../services/provider-chain", () => ({ listTenantProviderLinks: vi.fn(), resolveTenantCompletionLink: vi.fn(), commitTrialCompletion: vi.fn(), refundTrialCompletion: vi.fn() }));
vi.mock("../../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../handoff.service", () => ({ createHandoff: vi.fn(), claimHandoff: vi.fn(), cancelOpenHandoffForRun: vi.fn(), HandoffClaimError: class extends Error {} }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "test", OFFLINE_MODE: false } }));
import { runRouter } from "../router";

const handler = (runRouter as any).stack.find((l: any) => l.route?.path === "/:id/stream").route.stack[0].handle;
function event(seq: number) { return { type: "RUN_STARTED", runId: "run-fixture", seq, ts: "2026-10-19T00:00:00Z" }; }
function fixture(writeResult = true) {
  const sub = Object.assign(new EventEmitter(), { subscribe: vi.fn().mockResolvedValue(1), unsubscribe: vi.fn().mockResolvedValue(1), quit: vi.fn().mockResolvedValue("OK") });
  m.duplicate.mockReturnValue(sub);
  const req = Object.assign(new EventEmitter(), { params: { id: "run-fixture" }, auth: { tenantId: "tenant-fixture" }, headers: {}, query: {} });
  const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn().mockReturnValue(writeResult), end: vi.fn(), destroy: vi.fn() });
  return { req, res, sub };
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); m.find.mockResolvedValue({ id: "run-fixture", status: "RUNNING" }); m.buffered.mockResolvedValue([]); });
afterEach(() => vi.useRealTimers());

it("waits for drain and disconnects only after the finite backpressure deadline", async () => {
  m.buffered.mockResolvedValue([event(1), event(2)]);
  const h = fixture(false); await handler(h.req, h.res);
  expect(h.res.write).toHaveBeenCalledOnce();
  expect(h.res.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(h.res.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.res.destroy).toHaveBeenCalledOnce();
  expect(h.sub.quit).toHaveBeenCalledOnce();
  expect(h.sub.listenerCount("message")).toBe(0);
  expect(h.res.listenerCount("drain")).toBe(0);
});
it("delivers a healthy large frame through real Writable backpressure before terminal completion", async () => {
  const large = { ...event(1), content: "x".repeat(64 * 1024) };
  const completed = { ...event(2), type: "RUN_COMPLETED" };
  m.buffered.mockResolvedValue([large, completed]);
  const h = fixture();
  const frames: string[] = [];
  let releaseFirst!: () => void;
  const res = Object.assign(new Writable({
    highWaterMark: 1024,
    autoDestroy: false,
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      if (frames.length === 1) releaseFirst = callback;
      else callback();
    },
  }), { writeHead: vi.fn(), flushHeaders: vi.fn() });
  const end = vi.spyOn(res, "end");
  const destroy = vi.spyOn(res, "destroy");
  await handler(h.req, res);
  expect(frames).toHaveLength(1);
  expect(end).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  releaseFirst();
  await finished;
  expect(frames).toEqual([
    `id: 1\ndata: ${JSON.stringify(large)}\n\n`,
    `id: 2\ndata: ${JSON.stringify(completed)}\n\n`,
    "event: done\ndata: {}\n\n",
  ]);
  expect(end).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
  expect(h.sub.quit).toHaveBeenCalledOnce();
});
it("bounds live buffering while the replay read is pending", async () => {
  let resolve!: (events: unknown[]) => void;
  m.buffered.mockReturnValue(new Promise((r) => { resolve = r; }));
  const h = fixture(); const pending = handler(h.req, h.res);
  await Promise.resolve(); await Promise.resolve();
  for (let n = 1; n <= 251; n++) h.sub.emit("message", "run:run-fixture", JSON.stringify(event(n)));
  expect(h.res.destroy).toHaveBeenCalledOnce();
  resolve([]); await pending;
  expect(h.res.write).not.toHaveBeenCalled();
});
it("bounds bytes as well as event count while replay is pending", async () => {
  let resolve!: (events: unknown[]) => void;
  m.buffered.mockReturnValue(new Promise((r) => { resolve = r; }));
  const h = fixture(); const pending = handler(h.req, h.res);
  await Promise.resolve(); await Promise.resolve();
  h.sub.emit("message", "run:run-fixture", JSON.stringify({ ...event(1), content: "x".repeat(1024 * 1024) }));
  expect(h.res.destroy).toHaveBeenCalledOnce();
  resolve([]); await pending;
  expect(h.res.write).not.toHaveBeenCalled();
});
it("gives a backpressured heartbeat the same finite drain deadline", async () => {
  const h = fixture(); await handler(h.req, h.res);
  h.res.write.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(h.res.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.res.destroy).toHaveBeenCalledOnce();
  expect(h.sub.quit).toHaveBeenCalledOnce();
});
it.each(["count", "bytes"])("bounds outgoing %s while a response waits for drain", async (limit) => {
  const h = fixture(false); await handler(h.req, h.res);
  h.sub.emit("message", "run:run-fixture", JSON.stringify(event(1)));
  if (limit === "count") {
    for (let seq = 2; seq <= 252; seq++) h.sub.emit("message", "run:run-fixture", JSON.stringify(event(seq)));
  } else {
    h.sub.emit("message", "run:run-fixture", JSON.stringify({ ...event(2), content: "x".repeat(1024 * 1024) }));
  }
  expect(h.res.write).toHaveBeenCalledOnce();
  expect(h.res.destroy).toHaveBeenCalledOnce();
  expect(h.sub.quit).toHaveBeenCalledOnce();
  expect(h.res.listenerCount("drain")).toBe(0);
});
it("releases a disconnected response during drain without later writes or timers", async () => {
  m.buffered.mockResolvedValue([event(1), event(2)]);
  const h = fixture(false); await handler(h.req, h.res);
  h.res.emit("close");
  h.res.emit("drain");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.res.write).toHaveBeenCalledOnce();
  expect(h.res.destroy).toHaveBeenCalledOnce();
  expect(h.sub.quit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.req.listenerCount("close")).toBe(0);
});
it("preserves ordered replay, live deduplication and terminal completion for a reading client", async () => {
  m.buffered.mockResolvedValue([event(1), event(2)]);
  const h = fixture(); await handler(h.req, h.res);
  h.sub.emit("message", "run:run-fixture", JSON.stringify(event(2)));
  h.sub.emit("message", "run:run-fixture", JSON.stringify({ ...event(3), type: "RUN_COMPLETED" }));
  expect(h.res.write.mock.calls.map((c) => c[0])).toEqual([
    `id: 1\ndata: ${JSON.stringify(event(1))}\n\n`, `id: 2\ndata: ${JSON.stringify(event(2))}\n\n`,
    `id: 3\ndata: ${JSON.stringify({ ...event(3), type: "RUN_COMPLETED" })}\n\n`, "event: done\ndata: {}\n\n",
  ]);
  expect(h.res.end).toHaveBeenCalledOnce(); expect(h.res.destroy).not.toHaveBeenCalled();
});
