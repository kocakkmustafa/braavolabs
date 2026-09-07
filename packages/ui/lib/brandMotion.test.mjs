import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  runMotion, wizardMotion, approvalMotion, motionFrames, heldFrame,
  createGesturePlayer, subscribeMotionEnvironment,
} from "./brandMotion.ts";

test("run truth follows authoritative status, including stale approval precedence", () => {
  const expected = {
    RUNNING: "thinking", COMPLETED: "success", WAITING_APPROVAL: "attention",
    FAILED: "error", PENDING: "idle", PAUSED: "idle", CANCELLED: "idle", ROLLED_BACK: "idle",
  };
  for (const [status, state] of Object.entries(expected)) {
    assert.equal(runMotion(status), state);
    assert.equal(runMotion(status.toLowerCase()), state);
    assert.equal(runMotion(status, true), status === "RUNNING" ? "attention" : state);
  }
  for (const status of [null, undefined, "", "UNKNOWN", "constructor", "toString"]) {
    assert.equal(runMotion(status, true), "idle");
  }
});

test("wizard only celebrates a confirmed created company, never an empty or failed preview", () => {
  assert.equal(wizardMotion({ step: "clarify", busy: true }), "thinking");
  assert.equal(wizardMotion({ step: "creating" }), "thinking");
  assert.equal(wizardMotion({ step: "preview", session: { status: "ready" } }), "idle");
  assert.equal(wizardMotion({ step: "done", session: { status: "created", companyId: "company-1" } }), "success");
  for (const session of [null, {}, { status: "ready", companyId: "company-1" }, { status: "created" }, { status: "created", companyId: " " }]) {
    assert.equal(wizardMotion({ step: "done", session }), "idle");
  }
  assert.equal(wizardMotion({ step: "preview", error: "Failed", session: { status: "ready" } }), "error");
  assert.equal(approvalMotion(0), "idle");
  assert.equal(approvalMotion(2), "attention");
  assert.equal(approvalMotion(2, "Failed"), "error");
});

test("a failed confirmation can retry and succeed while its prior error remains in the wizard", () => {
  const priorError = "First confirmation failed";
  const readySession = { status: "ready" };
  assert.equal(wizardMotion({ step: "preview", error: priorError, session: readySession }), "error");
  assert.equal(wizardMotion({ step: "creating", busy: true, error: priorError, session: readySession }), "thinking");
  assert.equal(wizardMotion({ step: "preview", busy: true, error: priorError, session: readySession }), "thinking");
  assert.equal(wizardMotion({ step: "done", error: priorError, session: { status: "created", companyId: "company-1" } }), "success");
  for (const session of [null, {}, readySession, { status: "created" }, { status: "created", companyId: " " }]) {
    assert.equal(wizardMotion({ step: "done", error: priorError, session }), "error");
    assert.equal(wizardMotion({ step: "done", session }), "idle");
  }
});

test("the shipped atlas and frame sequences exactly match the approved snapshot", () => {
  const contract = JSON.parse(readFileSync(new URL("../public/brand/approved-motion.json", import.meta.url), "utf8"));
  const atlas = readFileSync(new URL("../public/brand/mascot-gestures-expressive-v1.png", import.meta.url));
  assert.equal(contract.sha256, "bded08adb94b029545b3e0a584a9efaa5d88b2b1ce00b60b1e1de84dd031fcc3");
  assert.deepEqual(contract.states, {
    idle: { frames: [0], delays: [] },
    thinking: { frames: [0, 2, 3], delays: [450, 220] },
    success: { frames: [4, 5, 6, 7], delays: [420, 160, 240] },
    attention: { frames: [8, 10, 11], delays: [450, 240] },
    error: { frames: [0], delays: [] },
  });
  assert.deepEqual([contract.width, contract.height, contract.columns, contract.rows, contract.cell], [1448, 1086, 4, 3, 362]);
  assert.equal(createHash("sha256").update(atlas).digest("hex"), contract.sha256);
  assert.equal(atlas.readUInt32BE(16), contract.width);
  assert.equal(atlas.readUInt32BE(20), contract.height);
  for (const [state, sequence] of Object.entries(contract.states)) {
    assert.deepEqual(motionFrames(state), sequence);
    assert.equal(heldFrame(state), sequence.frames.at(-1));
    assert.equal(sequence.delays.length, sequence.frames.length - 1);
    assert.ok(sequence.frames.every((frame) => ![1, 9].includes(frame)));
  }
});

function fakeClock() {
  let now = 0;
  let serial = 0;
  const jobs = new Map();
  return {
    schedule(callback, delay) { const id = ++serial; jobs.set(id, { callback, at: now + delay }); return id; },
    cancel(id) { jobs.delete(id); },
    advance(delta) {
      const end = now + delta;
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]); next[1].callback();
      }
      now = end;
    },
    get pending() { return jobs.size; },
  };
}

test("gestures play the approved finite timing once, then hold without a timer", () => {
  const clock = fakeClock();
  const frames = [];
  const player = createGesturePlayer((frame) => frames.push(frame), clock);
  player.update("thinking", true);
  assert.deepEqual(frames, [0]);
  clock.advance(449); assert.deepEqual(frames, [0]);
  clock.advance(1); assert.deepEqual(frames, [0, 2]);
  clock.advance(220); assert.deepEqual(frames, [0, 2, 3]);
  clock.advance(5000); player.update("thinking", true);
  assert.deepEqual(frames, [0, 2, 3]);
  assert.equal(clock.pending, 0);
});

test("state changes cancel old frames, and reduce/hidden/offscreen freezes a final pose", () => {
  const clock = fakeClock();
  const frames = [];
  const player = createGesturePlayer((frame) => frames.push(frame), clock);
  player.update("success", true);
  clock.advance(420);
  player.update("attention", true);
  assert.equal(clock.pending, 1);
  player.update("attention", false);
  assert.equal(frames.at(-1), 11);
  assert.equal(clock.pending, 0);
  player.update("attention", true);
  clock.advance(5000);
  assert.equal(frames.at(-1), 11);
  assert.equal(clock.pending, 0);
  player.update("thinking", true);
  assert.equal(clock.pending, 1);
  player.dispose(); player.dispose();
  const afterDispose = [...frames];
  clock.advance(5000); player.update("success", true);
  assert.deepEqual(frames, afterDispose);
  assert.equal(clock.pending, 0);
});

test("reduced first render holds a meaningful final frame without starting a timer", () => {
  const clock = fakeClock();
  const frames = [];
  const player = createGesturePlayer((frame) => frames.push(frame), clock);
  player.update("success", false);
  assert.deepEqual(frames, [7]);
  assert.equal(clock.pending, 0);
});

test("visibility/media/intersection subscriptions remain conservative and dispose completely", () => {
  function source(fields) {
    const listeners = new Map();
    return {
      ...fields,
      addEventListener(type, callback) { listeners.set(type, callback); },
      removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
      emit(type) { listeners.get(type)?.(); },
      get count() { return listeners.size; },
    };
  }
  const media = source({ matches: true }); // no-preference
  const page = source({ visibilityState: "visible" });
  let intersect;
  let disconnected = 0;
  const changes = [];
  const stop = subscribeMotionEnvironment({
    media, page,
    observe(callback) { intersect = callback; return () => { disconnected += 1; }; },
  }, (enabled) => changes.push(enabled));
  assert.deepEqual(changes, []); // wait for first intersection, never animate speculatively
  intersect(true); assert.equal(changes.at(-1), true);
  page.visibilityState = "hidden"; page.emit("visibilitychange"); assert.equal(changes.at(-1), false);
  page.visibilityState = "visible"; page.emit("visibilitychange"); assert.equal(changes.at(-1), true);
  media.matches = false; media.emit("change"); assert.equal(changes.at(-1), false);
  media.matches = true; media.emit("change");
  intersect(false); assert.equal(changes.at(-1), false);
  stop(); stop();
  assert.equal(disconnected, 1);
  assert.equal(media.count + page.count, 0);
  const count = changes.length;
  intersect(true); assert.equal(changes.length, count);
});
