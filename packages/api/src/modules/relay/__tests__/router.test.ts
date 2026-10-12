/**
 * Relay router — transport smoke tests against a MOCKED Redis (no live
 * Redis). Exercises register → event publish → companion SSE receipt,
 * companion command → local-session SSE receipt, cross-tenant AND
 * cross-user-same-tenant 404s (owner-binding, adversarial review P2),
 * redaction end-to-end, the P1 restart/sessionId-reuse leak scenario, and
 * the P2-3/P2-4 hardening (confirmed command delivery, DoS caps).
 *
 * Handlers are extracted directly from the Router stack and invoked with a
 * mock req/res/next — same harness convention as webhook/router.test.ts and
 * run/__tests__/explain-router.test.ts. The fake Redis client below
 * implements just enough of the ioredis surface (incr/persist/expire/lrange/multi/
 * duplicate/subscribe/unsubscribe/quit/on) for bus.ts's runEvents-mirrored
 * idiom to work, with `.duplicate()` sharing the same in-memory store/bus so
 * a "companion" subscriber connection sees what a "local session" publish
 * connection writes — mirroring two real, separate Redis connections. It
 * also exposes `__relayTestControls` (test-only) so a single test can force
 * the next `multi().exec()` to fail, simulating a Redis blip for the P2-3
 * confirmed-delivery test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../../lib/redis", () => {
  interface Shared {
    lists: Map<string, string[]>;
    counters: Map<string, number>;
    channels: Map<string, Set<(msg: string) => void>>;
    forceExecError: boolean;
    now: number;
    expires: Map<string, number>;
    sequenceFailure?: "incr" | "persist" | "abort";
  }

  function expireIfNeeded(shared: Shared, key: string) {
    const deadline = shared.expires.get(key);
    if (deadline !== undefined && deadline <= shared.now) {
      shared.expires.delete(key);
      shared.counters.delete(key);
      shared.lists.delete(key);
    }
  }

  function createClient(shared: Shared) {
    const messageHandlers: Array<(ch: string, msg: string) => void> = [];
    const localSubs = new Map<string, (msg: string) => void>();

    const client: any = {
      incr: async (key: string) => {
        expireIfNeeded(shared, key);
        const v = (shared.counters.get(key) ?? 0) + 1;
        shared.counters.set(key, v);
        return v;
      },
      expire: async (key: string, seconds: number) => {
        expireIfNeeded(shared, key);
        shared.expires.set(key, shared.now + seconds);
        return 1;
      },
      lrange: async (key: string) => {
        expireIfNeeded(shared, key);
        return shared.lists.get(key) ?? [];
      },
      multi: () => {
        const ops: Array<() => unknown> = [];
        let sequenceTransaction = false;
        const m: any = {
          incr: (key: string) => {
            sequenceTransaction = true;
            ops.push(() => {
              if (shared.sequenceFailure === "incr") throw new Error("simulated INCR error");
              expireIfNeeded(shared, key);
              const v = (shared.counters.get(key) ?? 0) + 1;
              shared.counters.set(key, v);
              return v;
            });
            return m;
          },
          persist: (key: string) => {
            ops.push(() => {
              if (shared.sequenceFailure === "persist") throw new Error("simulated PERSIST error");
              expireIfNeeded(shared, key);
              return shared.expires.delete(key) ? 1 : 0;
            });
            return m;
          },
          rpush: (key: string, val: string) => {
            ops.push(() => {
              expireIfNeeded(shared, key);
              const arr = shared.lists.get(key) ?? [];
              arr.push(val);
              shared.lists.set(key, arr);
            });
            return m;
          },
          ltrim: (key: string, start: number, end: number) => {
            ops.push(() => {
              expireIfNeeded(shared, key);
              const arr = shared.lists.get(key) ?? [];
              const trimmed = start < 0 && end === -1 ? arr.slice(start) : arr.slice(start, end + 1);
              shared.lists.set(key, trimmed);
            });
            return m;
          },
          expire: (key: string, seconds: number) => {
            ops.push(() => { shared.expires.set(key, shared.now + seconds); return 1; });
            return m;
          },
          publish: (channel: string, msg: string) => {
            ops.push(() => {
              shared.channels.get(channel)?.forEach((cb) => cb(msg));
            });
            return m;
          },
          exec: async () => {
            if (shared.forceExecError) throw new Error("simulated Redis blip (test-forced)");
            if (sequenceTransaction && shared.sequenceFailure === "abort") return null;
            return ops.map((op) => {
              try { return [null, op()]; } catch (err) { return [err, null]; }
            });
          },
        };
        return m;
      },
      subscribe: async (channel: string) => {
        const handler = (msg: string) => messageHandlers.forEach((h) => h(channel, msg));
        if (!shared.channels.has(channel)) shared.channels.set(channel, new Set());
        shared.channels.get(channel)!.add(handler);
        localSubs.set(channel, handler);
      },
      unsubscribe: async (channel: string) => {
        const handler = localSubs.get(channel);
        if (handler) shared.channels.get(channel)?.delete(handler);
        localSubs.delete(channel);
      },
      quit: async () => {},
      on: (event: string, cb: any) => {
        if (event === "message") messageHandlers.push(cb);
        return client;
      },
      removeAllListeners: (event: string) => {
        if (event === "message") messageHandlers.length = 0;
        return client;
      },
      duplicate: () => createClient(shared),
    };
    return client;
  }

  const shared: Shared = { lists: new Map(), counters: new Map(), channels: new Map(), forceExecError: false, now: 0, expires: new Map() };
  return {
    redis: createClient(shared),
    __relayTestControls: {
      setForceExecError: (v: boolean) => { shared.forceExecError = v; },
      setClock: (seconds: number) => { shared.now = seconds; },
      setSequenceFailure: (failure?: Shared["sequenceFailure"]) => { shared.sequenceFailure = failure; },
      seedLegacyExpiry: (key: string) => { shared.expires.set(key, shared.now + 3600); },
    },
  };
});

import { relayRouter, relayState } from "../router";
import { registerSession as coreRegisterSession, authorizeCommand, DEFAULT_MAX_SESSIONS_PER_TENANT } from "../relay.core";
import { __relayTestControls } from "../../../lib/redis";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next?: any) => Promise<void> | void;
}

function mockReq(overrides: Record<string, unknown> = {}) {
  const closeHandlers: Array<() => void> = [];
  const req: any = {
    params: {},
    query: {},
    headers: {},
    body: {},
    auth: { tenantId: "tenant-a", userId: "user-1", role: "member" },
    on: (event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    },
    __close: () => closeHandlers.forEach((cb) => cb()),
    ...overrides,
  };
  return req;
}

function mockRes() {
  const chunks: string[] = [];
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    ended: false,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    writeHead(code: number, hdrs: Record<string, string>) {
      this.statusCode = code;
      Object.assign(this.headers, hdrs);
    },
    flushHeaders() {},
    write(chunk: string) { chunks.push(chunk); return true; },
    end() { this.ended = true; },
    chunks,
  };
  return res;
}

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any;
  const next = (err?: any) => { nextErr = err; };
  await handler(req, res, next);
  return { res, nextErr };
}

describe("relay router — transport smoke (mocked Redis)", () => {
  const registerHandler = getHandler(relayRouter, "post", "/sessions");
  const listHandler = getHandler(relayRouter, "get", "/sessions");
  const postEventHandler = getHandler(relayRouter, "post", "/sessions/:id/events");
  const getEventsSSE = getHandler(relayRouter, "get", "/sessions/:id/events");
  const getEventsPoll = getHandler(relayRouter, "get", "/sessions/:id/events/poll");
  const postCommandHandler = getHandler(relayRouter, "post", "/sessions/:id/commands");
  const getCommandsSSE = getHandler(relayRouter, "get", "/sessions/:id/commands");

  const liveReqs: any[] = [];

  beforeEach(() => {
    relayState.sessions.clear();
    __relayTestControls.setForceExecError(false);
    __relayTestControls.setClock(0);
    __relayTestControls.setSequenceFailure();
    // Deliberately NOT resetting relayState.counter: the fake Redis store
    // (buffers/seq counters, keyed by tenantId+sessionId) is a module-level
    // singleton that lives for the whole test FILE, not per test. Session
    // ids in this suite come from the router's real crypto-random generator
    // anyway (P1 fix), so cross-test key collisions are a non-issue.
    liveReqs.length = 0;
  });

  afterEach(() => {
    // Close every SSE connection opened in the test so its heartbeat
    // setInterval doesn't leak into the next test.
    liveReqs.forEach((r) => r.__close());
  });

  function auth(tenantId: string, userId: string) {
    return { tenantId, userId, role: "member" };
  }

  async function httpRegisterSession(tenantId: string, userId = "u", surface: "desktop" | "cli" = "desktop") {
    const { res } = await invoke(registerHandler, mockReq({ auth: auth(tenantId, userId), body: { surface } }));
    return res.body.sessionId as string;
  }

  async function openEventsSSE(tenantId: string, userId: string, sessionId: string) {
    const req = mockReq({ auth: auth(tenantId, userId), params: { id: sessionId } });
    const res = mockRes();
    liveReqs.push(req);
    await getEventsSSE(req, res);
    return { req, res };
  }

  async function openCommandsSSE(tenantId: string, userId: string, sessionId: string) {
    const req = mockReq({ auth: auth(tenantId, userId), params: { id: sessionId } });
    const res = mockRes();
    liveReqs.push(req);
    await getCommandsSSE(req, res);
    return { req, res };
  }

  it("events/poll returns buffered events after `after` + the ended flag (RN no-SSE path)", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    // Publish two events as the owner.
    for (const ev of [
      { type: "status", state: "running" },
      { type: "output", textB64: Buffer.from("hello").toString("base64") },
    ]) {
      await invoke(postEventHandler, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body: ev }));
    }
    const { res } = await invoke(getEventsPoll, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, query: {} }));
    expect(res.statusCode ?? 200).toBe(200);
    expect(res.body.events.length).toBe(2);
    expect(res.body.lastSeq).toBe(res.body.events[1].seq);
    expect(res.body.ended).toBe(false);
    // Poll again with `after=lastSeq` → no new events.
    const again = await invoke(getEventsPoll, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, query: { after: String(res.body.lastSeq) } }));
    expect(again.res.body.events.length).toBe(0);
  });

  it("events/poll is owner-bound: another user in the same tenant gets 404, not the events", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    await invoke(postEventHandler, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body: { type: "status", state: "running" } }));
    const { res } = await invoke(getEventsPoll, mockReq({ auth: auth("tenant-a", "teammate"), params: { id: sessionId }, query: {} }));
    expect(res.statusCode).toBe(404);
    expect(res.body.events).toBeUndefined();
  });

  it("register → event publish → companion SSE receives it (same owner, two devices)", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const companion = await openEventsSSE("tenant-a", "u", sessionId);
    expect(companion.res.statusCode).toBe(200);
    expect(companion.res.headers["Content-Type"]).toBe("text/event-stream");

    const { res: postRes, nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: auth("tenant-a", "u"),
        params: { id: sessionId },
        body: { type: "agent-turn", summary: "Wrote 3 files and ran the tests." },
      }),
    );
    expect(nextErr).toBeUndefined();
    expect(postRes.statusCode).toBe(202);

    const received = companion.res.chunks.join("");
    expect(received).toContain("agent-turn");
    expect(received).toContain("Wrote 3 files and ran the tests.");
  });

  it("companion command → local session's command SSE stream receives it (same owner)", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u", "cli");
    const local = await openCommandsSSE("tenant-a", "u", sessionId);

    const { res: postRes, nextErr } = await invoke(
      postCommandHandler,
      mockReq({
        auth: auth("tenant-a", "u"),
        params: { id: sessionId },
        body: { type: "steer", message: "slow down and re-check the diff" },
      }),
    );
    expect(nextErr).toBeUndefined();
    expect(postRes.statusCode).toBe(202);

    const received = local.res.chunks.join("");
    expect(received).toContain("\"type\":\"steer\"");
    expect(received).toContain("slow down and re-check the diff");
  });

  it("GET /relay/sessions only lists the caller's own tenant+user sessions (owner-scoped)", async () => {
    await httpRegisterSession("tenant-a", "u");
    await httpRegisterSession("tenant-a", "u");
    await httpRegisterSession("tenant-a", "teammate"); // same tenant, DIFFERENT user — must not appear
    await httpRegisterSession("tenant-b", "u"); // different tenant, same userId string — must not appear

    const { res } = await invoke(listHandler, mockReq({ auth: auth("tenant-a", "u") }));
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0]).not.toHaveProperty("tenantId");
    expect(res.body.sessions[0]).not.toHaveProperty("userId");
  });

  it("CROSS-TENANT: posting an event against another tenant's session → 404, event never published", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");

    const { res, nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: auth("tenant-b", "attacker"),
        params: { id: sessionId },
        body: { type: "agent-turn", summary: "should never be published" },
      }),
    );
    expect(nextErr?.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });

  it("P2 CROSS-USER-SAME-TENANT (impersonation guard): a teammate posting an event on your session → 404, event never published", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const owner = await openEventsSSE("tenant-a", "u", sessionId);

    const { nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: auth("tenant-a", "teammate"), // SAME tenant, DIFFERENT user
        params: { id: sessionId },
        body: { type: "approval-request", actionId: "act-x", kind: "shell.exec", dialogText: "forged by teammate" },
      }),
    );
    expect(nextErr?.statusCode).toBe(404);
    expect(owner.res.chunks.join("")).not.toContain("forged by teammate");
  });

  it("CROSS-TENANT: sending a command against another tenant's session → 404, command never published", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const owner = await openCommandsSSE("tenant-a", "u", sessionId);

    const { nextErr } = await invoke(
      postCommandHandler,
      mockReq({
        auth: auth("tenant-b", "attacker"),
        params: { id: sessionId },
        body: { type: "kill" },
      }),
    );
    expect(nextErr?.statusCode).toBe(404);
    expect(owner.res.chunks.join("")).not.toContain("\"type\":\"kill\"");
  });

  it("P2 APPROVE-HIJACK: a teammate in the SAME tenant sending approve/kill on your session → 404, command never published", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const owner = await openCommandsSSE("tenant-a", "u", sessionId);

    const approveAttempt = await invoke(
      postCommandHandler,
      mockReq({
        auth: auth("tenant-a", "teammate"),
        params: { id: sessionId },
        body: { type: "approve", actionId: "act-1" },
      }),
    );
    expect(approveAttempt.nextErr?.statusCode).toBe(404);

    const killAttempt = await invoke(
      postCommandHandler,
      mockReq({
        auth: auth("tenant-a", "teammate"),
        params: { id: sessionId },
        body: { type: "kill" },
      }),
    );
    expect(killAttempt.nextErr?.statusCode).toBe(404);
    expect(owner.res.chunks.join("")).toBe("");
    // The session must still be authorizable by its REAL owner — the
    // hijack attempt must not have side-effected the session's lifecycle.
    expect(authorizeCommand(relayState, "tenant-a", "u", sessionId, { type: "kill" })).toEqual({ ok: true });
  });

  it("CROSS-TENANT: opening the events SSE stream for another tenant's session → 404, no stream opened", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const req = mockReq({ auth: auth("tenant-b", "attacker"), params: { id: sessionId } });
    const res = mockRes();
    await getEventsSSE(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toBeUndefined();
  });

  it("P2 CROSS-USER-SAME-TENANT: opening the events SSE stream for a teammate's session → 404, no stream opened", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const req = mockReq({ auth: auth("tenant-a", "teammate"), params: { id: sessionId } });
    const res = mockRes();
    await getEventsSSE(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toBeUndefined();
  });

  it("REDACTION: a secret-shaped approval-request event arrives at the companion already redacted", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const companion = await openEventsSSE("tenant-a", "u", sessionId);

    await invoke(
      postEventHandler,
      mockReq({
        auth: auth("tenant-a", "u"),
        params: { id: sessionId },
        body: {
          type: "approval-request",
          actionId: "act-1",
          kind: "shell.exec",
          dialogText: "export KEY=sk-ABCDEFGHIJ1234567890 && deploy.sh",
        },
      }),
    );

    const received = companion.res.chunks.join("");
    expect(received).not.toContain("sk-ABCDEFGHIJ1234567890");
    expect(received).toContain("«redacted»");
    // actionId must survive intact — a companion approving this action later
    // needs the REAL id (round-trip safety, P3 nuance).
    expect(received).toContain("\"actionId\":\"act-1\"");
  });

  it("REDACTION: base64 output containing a Bearer token arrives decoded-and-redacted", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const companion = await openEventsSSE("tenant-a", "u", sessionId);
    const raw = "curl -H 'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' https://api.internal";

    await invoke(
      postEventHandler,
      mockReq({
        auth: auth("tenant-a", "u"),
        params: { id: sessionId },
        body: { type: "output", textB64: Buffer.from(raw, "utf8").toString("base64") },
      }),
    );

    const dataLine = companion.res.chunks.join("").split("\n").find((l: string) => l.startsWith("data: "));
    const event = JSON.parse(dataLine!.slice("data: ".length));
    const decoded = Buffer.from(event.textB64, "base64").toString("utf8");
    expect(decoded).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(decoded).toContain("«redacted»");
  });

  it("REDACTION: label/cwd containing a secret-shaped value arrive redacted in the session list", async () => {
    await invoke(registerHandler, mockReq({
      auth: auth("tenant-a", "u"),
      body: { surface: "cli", label: "sk-ABCDEFGHIJ1234567890", cwd: "/repo" },
    }));
    const { res } = await invoke(listHandler, mockReq({ auth: auth("tenant-a", "u") }));
    expect(res.body.sessions[0].label).toBe("«redacted»");
  });

  it("malformed event body → validation error, never published", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const companion = await openEventsSSE("tenant-a", "u", sessionId);

    const { nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: auth("tenant-a", "u"),
        params: { id: sessionId },
        body: { type: "agent-turn" /* missing summary */ },
      }),
    );
    expect(nextErr).toBeTruthy();
    expect(companion.res.chunks.join("")).toBe("");
  });

  it("last-event-id resume: a reconnecting companion only replays events after its cursor", async () => {
    const sessionId = await httpRegisterSession("tenant-a", "u");
    const first = await openEventsSSE("tenant-a", "u", sessionId);

    await invoke(postEventHandler, mockReq({
      auth: auth("tenant-a", "u"),
      params: { id: sessionId },
      body: { type: "status", state: "running" },
    }));
    await invoke(postEventHandler, mockReq({
      auth: auth("tenant-a", "u"),
      params: { id: sessionId },
      body: { type: "agent-turn", summary: "second event" },
    }));

    // Reconnect with Last-Event-ID = 1 (has already seen seq 1, the status event).
    const resumed = mockReq({
      auth: auth("tenant-a", "u"),
      params: { id: sessionId },
      headers: { "last-event-id": "1" },
    });
    const resumedRes = mockRes();
    liveReqs.push(resumed);
    await getEventsSSE(resumed, resumedRes);

    const received = resumedRes.chunks.join("");
    expect(received).not.toContain("\"type\":\"status\"");
    expect(received).toContain("second event");
  });

  describe("sequence lifetime (mock Redis clock, actual bus and router)", () => {
    const frames = (res: any) => res.chunks.filter((chunk: string) => chunk.startsWith("id: "))
      .map((chunk: string) => JSON.parse(chunk.split("data: ")[1]!.trim()));

    for (const direction of ["commands", "events"] as const) {
      const publish = direction === "commands" ? postCommandHandler : postEventHandler;
      const stream = direction === "commands" ? getCommandsSSE : getEventsSSE;
      const body = direction === "commands"
        ? { type: "steer", message: "same text is a separate command" }
        : { type: "agent-turn", summary: "same text is a separate event" };

      it(`${direction}: live delivery and cursor replay survive the original one-hour counter deadline`, async () => {
        const sessionId = await httpRegisterSession("tenant-a", "u", "cli");
        const req = mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId } });
        const live = mockRes();
        liveReqs.push(req);
        await stream(req, live);
        for (const seconds of [0, 3599, 3601]) {
          __relayTestControls.setClock(seconds);
          const result = await invoke(publish, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body }));
          expect(result.nextErr).toBeUndefined();
          expect(result.res.statusCode).toBe(202);
        }
        expect(frames(live).map((frame: any) => frame.seq)).toEqual([1, 2, 3]);
        const resumedReq = mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, query: { lastEventId: "2" } });
        const resumed = mockRes();
        liveReqs.push(resumedReq);
        await stream(resumedReq, resumed);
        expect(frames(resumed).map((frame: any) => frame.seq)).toEqual([3]);
      });

      it(`${direction}: a session idle longer than the buffer TTL keeps its cursor`, async () => {
        const sessionId = await httpRegisterSession("tenant-a", "u", "cli");
        await invoke(publish, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body }));
        __relayTestControls.setClock(7201);
        await invoke(publish, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body }));
        const req = mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, headers: { "last-event-id": "1" } });
        const res = mockRes();
        liveReqs.push(req);
        await stream(req, res);
        expect(frames(res).map((frame: any) => frame.seq)).toEqual([2]);
      });

      it(`${direction}: publishing removes an unexpired counter TTL from the old implementation`, async () => {
        const sessionId = await httpRegisterSession("tenant-a", "u", "cli");
        await invoke(publish, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body }));
        __relayTestControls.seedLegacyExpiry(`relay:sess:${direction === "commands" ? "cmds" : "events"}:seq:tenant-a:${sessionId}`);
        __relayTestControls.setClock(3599);
        await invoke(publish, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body }));
        __relayTestControls.setClock(7201);
        await invoke(publish, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body }));
        const req = mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, query: { lastEventId: "2" } });
        const res = mockRes();
        liveReqs.push(req);
        await stream(req, res);
        expect(frames(res).map((frame: any) => frame.seq)).toEqual([3]);
      });
    }

    it.each(["incr", "persist", "abort"] as const)("%s sequence failure returns 503 and keeps kill authorizable", async failure => {
      const sessionId = await httpRegisterSession("tenant-a", "u", "cli");
      const local = await openCommandsSSE("tenant-a", "u", sessionId);
      __relayTestControls.setSequenceFailure(failure);
      const result = await invoke(postCommandHandler, mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body: { type: "kill" } }));
      expect(result.nextErr?.statusCode).toBe(503);
      expect(frames(local.res)).toEqual([]);
      expect(authorizeCommand(relayState, "tenant-a", "u", sessionId, { type: "kill" })).toEqual({ ok: true });
    });
  });

  it("production session ids are crypto-random — not sequential, not guessable from a prior id", async () => {
    const id1 = await httpRegisterSession("tenant-a", "u");
    const id2 = await httpRegisterSession("tenant-a", "u");
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id2).toMatch(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  describe("P1 — restart / sessionId-reuse cross-tenant leak (adversarial review PoC)", () => {
    it("a sessionId collision across a simulated restart+tenant-change does NOT leak the prior generation's buffered events", async () => {
      // Force a sessionId COLLISION deliberately (bypassing the router's real
      // crypto generator) — this reproduces exactly what the PRE-FIX
      // counter-based mintSessionId would do after a process restart wiped
      // relayState.counter back to 0. Isolating the collision like this lets
      // this test verify layer 2 of the fix (tenant-namespaced Redis buffer
      // keys, bus.ts) independently of layer 1 (crypto-random ids, which
      // makes a REAL collision astronomically unlikely but isn't the only
      // guarantee — defense in depth).
      const COLLIDING_ID = "sess_collision-poc";

      // "Generation 1": tenant-a's local session registers and posts a
      // secret-bearing event under COLLIDING_ID.
      const gen1 = coreRegisterSession(relayState, "tenant-a", "victim-user", { surface: "desktop" }, { mintId: () => COLLIDING_ID });
      expect(gen1.ok).toBe(true);
      await invoke(postEventHandler, mockReq({
        auth: auth("tenant-a", "victim-user"),
        params: { id: COLLIDING_ID },
        body: { type: "agent-turn", summary: "GEN1-TENANT-A-CONFIDENTIAL-CONTENT" },
      }));

      // Simulate a process RESTART: the in-memory registry is wiped. The
      // Redis event buffer for COLLIDING_ID (tenant-a-namespaced) is NOT
      // touched — exactly like a real restart, where relayState resets but
      // Redis (TTL 3600s) survives.
      relayState.sessions.clear();

      // "Generation 2": a DIFFERENT tenant is issued the SAME id post-restart.
      const gen2 = coreRegisterSession(relayState, "tenant-b", "new-user", { surface: "desktop" }, { mintId: () => COLLIDING_ID });
      expect(gen2.ok).toBe(true);

      // Tenant B's own companion opens its OWN new session's stream.
      const companion = await openEventsSSE("tenant-b", "new-user", COLLIDING_ID);
      expect(companion.res.statusCode).toBe(200);

      // MUST NOT see tenant A's generation-1 secret — this assertion is the
      // adversarial review's PoC; it would FAIL against the pre-fix
      // single-namespace buffer key.
      const received = companion.res.chunks.join("");
      expect(received).not.toContain("GEN1-TENANT-A-CONFIDENTIAL-CONTENT");
      expect(received).toBe(""); // nothing at all for the fresh tenant-b session (no cross-generation carryover)
    });
  });

  describe("P2-3 — confirmed control-command delivery", () => {
    it("a failed publish (simulated Redis blip) returns 503, NOT a false-positive 202", async () => {
      const sessionId = await httpRegisterSession("tenant-a", "u");
      __relayTestControls.setForceExecError(true);

      const { nextErr } = await invoke(
        postCommandHandler,
        mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body: { type: "kill" } }),
      );
      expect(nextErr?.statusCode).toBe(503);

      __relayTestControls.setForceExecError(false);
    });

    it("a failed `kill` publish does NOT mark the session ended — the companion is never lied to about the local session's fate", async () => {
      const sessionId = await httpRegisterSession("tenant-a", "u");
      __relayTestControls.setForceExecError(true);

      await invoke(
        postCommandHandler,
        mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body: { type: "kill" } }),
      );

      __relayTestControls.setForceExecError(false);

      // The session must STILL be authorizable — proof endSession was never
      // called for the failed kill.
      const authz = authorizeCommand(relayState, "tenant-a", "u", sessionId, { type: "steer", message: "still alive?" });
      expect(authz).toEqual({ ok: true });
    });

    it("a successful `kill` publish DOES mark the session ended", async () => {
      const sessionId = await httpRegisterSession("tenant-a", "u");
      const { res } = await invoke(
        postCommandHandler,
        mockReq({ auth: auth("tenant-a", "u"), params: { id: sessionId }, body: { type: "kill" } }),
      );
      expect(res.statusCode).toBe(202);
      const authz = authorizeCommand(relayState, "tenant-a", "u", sessionId, { type: "steer", message: "x" });
      expect(authz.ok).toBe(false);
    });
  });

  describe("P2-4 — DoS guards", () => {
    it("registering beyond the per-tenant session cap returns 429", async () => {
      for (let i = 0; i < DEFAULT_MAX_SESSIONS_PER_TENANT; i++) {
        const { res } = await invoke(registerHandler, mockReq({ auth: auth("tenant-cap", `user-${i}`), body: { surface: "desktop" } }));
        expect(res.statusCode).toBe(201);
      }
      const { nextErr } = await invoke(registerHandler, mockReq({ auth: auth("tenant-cap", "one-too-many"), body: { surface: "desktop" } }));
      expect(nextErr?.statusCode).toBe(429);
    }, 20_000);

    it("opening more than the concurrent-SSE-per-tenant cap returns 429 on the overflow connection", async () => {
      const sessionId = await httpRegisterSession("tenant-sse-cap", "u");
      // MAX_CONCURRENT_SSE_PER_TENANT is 20 (router.ts, not exported —
      // black-box test: open 21 and expect only the last to be refused).
      const opens: Array<{ req: any; res: any }> = [];
      for (let i = 0; i < 20; i++) {
        const req = mockReq({ auth: auth("tenant-sse-cap", "u"), params: { id: sessionId } });
        const res = mockRes();
        liveReqs.push(req);
        await getEventsSSE(req, res);
        expect(res.statusCode).toBe(200);
        opens.push({ req, res });
      }
      const overflowReq = mockReq({ auth: auth("tenant-sse-cap", "u"), params: { id: sessionId } });
      const overflowRes = mockRes();
      await getEventsSSE(overflowReq, overflowRes);
      expect(overflowRes.statusCode).toBe(429);
    }, 20_000);
  });
});
