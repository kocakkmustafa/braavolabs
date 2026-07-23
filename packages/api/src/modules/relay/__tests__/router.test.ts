/**
 * Relay router — transport smoke tests against a MOCKED Redis (no live
 * Redis). Exercises register → event publish → companion SSE receipt,
 * companion command → local-session SSE receipt, cross-tenant 403/404,
 * and that a secret-shaped payload arrives redacted end-to-end.
 *
 * Handlers are extracted directly from the Router stack and invoked with a
 * mock req/res/next — same harness convention as webhook/router.test.ts and
 * run/__tests__/explain-router.test.ts. The fake Redis client below
 * implements just enough of the ioredis surface (incr/expire/lrange/multi/
 * duplicate/subscribe/unsubscribe/quit/on) for bus.ts's runEvents-mirrored
 * idiom to work, with `.duplicate()` sharing the same in-memory store/bus so
 * a "companion" subscriber connection sees what a "local session" publish
 * connection writes — mirroring two real, separate Redis connections.
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
  }

  function createClient(shared: Shared) {
    const messageHandlers: Array<(ch: string, msg: string) => void> = [];
    const localSubs = new Map<string, (msg: string) => void>();

    const client: any = {
      incr: async (key: string) => {
        const v = (shared.counters.get(key) ?? 0) + 1;
        shared.counters.set(key, v);
        return v;
      },
      expire: async () => 1,
      lrange: async (key: string) => shared.lists.get(key) ?? [],
      multi: () => {
        const ops: Array<() => void> = [];
        const m: any = {
          rpush: (key: string, val: string) => {
            ops.push(() => {
              const arr = shared.lists.get(key) ?? [];
              arr.push(val);
              shared.lists.set(key, arr);
            });
            return m;
          },
          ltrim: (key: string, start: number, end: number) => {
            ops.push(() => {
              const arr = shared.lists.get(key) ?? [];
              const trimmed = start < 0 && end === -1 ? arr.slice(start) : arr.slice(start, end + 1);
              shared.lists.set(key, trimmed);
            });
            return m;
          },
          expire: () => m, // TTL is a no-op in-memory — buffer already lives only for the test's duration
          publish: (channel: string, msg: string) => {
            ops.push(() => {
              shared.channels.get(channel)?.forEach((cb) => cb(msg));
            });
            return m;
          },
          exec: async () => {
            ops.forEach((op) => op());
            return [];
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

  const shared: Shared = { lists: new Map(), counters: new Map(), channels: new Map() };
  return { redis: createClient(shared) };
});

import { relayRouter, relayState } from "../router";

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
  const postCommandHandler = getHandler(relayRouter, "post", "/sessions/:id/commands");
  const getCommandsSSE = getHandler(relayRouter, "get", "/sessions/:id/commands");

  const liveReqs: any[] = [];

  beforeEach(() => {
    relayState.sessions.clear();
    // Deliberately NOT resetting relayState.counter: the fake Redis store
    // (buffers/seq counters, keyed by sessionId) is a module-level singleton
    // that lives for the whole test FILE, not per test. Keeping the counter
    // monotonic across tests guarantees every test gets a session id no
    // earlier test's Redis keys could already hold data under.
    liveReqs.length = 0;
  });

  afterEach(() => {
    // Close every SSE connection opened in the test so its heartbeat
    // setInterval doesn't leak into the next test.
    liveReqs.forEach((r) => r.__close());
  });

  async function registerSession(tenantId: string, surface: "desktop" | "cli" = "desktop") {
    const { res } = await invoke(registerHandler, mockReq({ auth: { tenantId, userId: "u", role: "member" }, body: { surface } }));
    return res.body.sessionId as string;
  }

  async function openEventsSSE(tenantId: string, sessionId: string) {
    const req = mockReq({ auth: { tenantId, userId: "u", role: "member" }, params: { id: sessionId } });
    const res = mockRes();
    liveReqs.push(req);
    await getEventsSSE(req, res);
    return { req, res };
  }

  async function openCommandsSSE(tenantId: string, sessionId: string) {
    const req = mockReq({ auth: { tenantId, userId: "u", role: "member" }, params: { id: sessionId } });
    const res = mockRes();
    liveReqs.push(req);
    await getCommandsSSE(req, res);
    return { req, res };
  }

  it("register → event publish → companion SSE receives it", async () => {
    const sessionId = await registerSession("tenant-a");
    const companion = await openEventsSSE("tenant-a", sessionId);
    expect(companion.res.statusCode).toBe(200);
    expect(companion.res.headers["Content-Type"]).toBe("text/event-stream");

    const { res: postRes, nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: { tenantId: "tenant-a", userId: "local", role: "member" },
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

  it("companion command → local session's command SSE stream receives it", async () => {
    const sessionId = await registerSession("tenant-a", "cli");
    const local = await openCommandsSSE("tenant-a", sessionId);

    const { res: postRes, nextErr } = await invoke(
      postCommandHandler,
      mockReq({
        auth: { tenantId: "tenant-a", userId: "companion", role: "member" },
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

  it("GET /relay/sessions only lists the caller's own tenant sessions", async () => {
    await registerSession("tenant-a");
    await registerSession("tenant-a");
    await registerSession("tenant-b");

    const { res } = await invoke(listHandler, mockReq({ auth: { tenantId: "tenant-a", userId: "u", role: "member" } }));
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.every((s: any) => true)).toBe(true); // shape sanity — no tenantId field leaked
    expect(res.body.sessions[0]).not.toHaveProperty("tenantId");
  });

  it("CROSS-TENANT: posting an event against another tenant's session → 404, event never published", async () => {
    const sessionId = await registerSession("tenant-a");

    const { res, nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: { tenantId: "tenant-b", userId: "attacker", role: "member" },
        params: { id: sessionId },
        body: { type: "agent-turn", summary: "should never be published" },
      }),
    );
    expect(nextErr?.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });

  it("CROSS-TENANT: sending a command against another tenant's session → 404, command never published", async () => {
    const sessionId = await registerSession("tenant-a");
    const owner = await openCommandsSSE("tenant-a", sessionId);

    const { nextErr } = await invoke(
      postCommandHandler,
      mockReq({
        auth: { tenantId: "tenant-b", userId: "attacker", role: "member" },
        params: { id: sessionId },
        body: { type: "kill" },
      }),
    );
    expect(nextErr?.statusCode).toBe(404);
    expect(owner.res.chunks.join("")).not.toContain("\"type\":\"kill\"");
  });

  it("CROSS-TENANT: opening the events SSE stream for another tenant's session → 404, no stream opened", async () => {
    const sessionId = await registerSession("tenant-a");
    const req = mockReq({ auth: { tenantId: "tenant-b", userId: "attacker", role: "member" }, params: { id: sessionId } });
    const res = mockRes();
    await getEventsSSE(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toBeUndefined();
  });

  it("REDACTION: a secret-shaped approval-request event arrives at the companion already redacted", async () => {
    const sessionId = await registerSession("tenant-a");
    const companion = await openEventsSSE("tenant-a", sessionId);

    await invoke(
      postEventHandler,
      mockReq({
        auth: { tenantId: "tenant-a", userId: "local", role: "member" },
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
  });

  it("REDACTION: base64 output containing a Bearer token arrives decoded-and-redacted", async () => {
    const sessionId = await registerSession("tenant-a");
    const companion = await openEventsSSE("tenant-a", sessionId);
    const raw = "curl -H 'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' https://api.internal";

    await invoke(
      postEventHandler,
      mockReq({
        auth: { tenantId: "tenant-a", userId: "local", role: "member" },
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

  it("malformed event body → validation error, never published", async () => {
    const sessionId = await registerSession("tenant-a");
    const companion = await openEventsSSE("tenant-a", sessionId);

    const { nextErr } = await invoke(
      postEventHandler,
      mockReq({
        auth: { tenantId: "tenant-a", userId: "local", role: "member" },
        params: { id: sessionId },
        body: { type: "agent-turn" /* missing summary */ },
      }),
    );
    expect(nextErr).toBeTruthy();
    expect(companion.res.chunks.join("")).toBe("");
  });

  it("last-event-id resume: a reconnecting companion only replays events after its cursor", async () => {
    const sessionId = await registerSession("tenant-a");
    const first = await openEventsSSE("tenant-a", sessionId);

    await invoke(postEventHandler, mockReq({
      auth: { tenantId: "tenant-a", userId: "local", role: "member" },
      params: { id: sessionId },
      body: { type: "status", state: "running" },
    }));
    await invoke(postEventHandler, mockReq({
      auth: { tenantId: "tenant-a", userId: "local", role: "member" },
      params: { id: sessionId },
      body: { type: "agent-turn", summary: "second event" },
    }));

    // Reconnect with Last-Event-ID = 1 (has already seen seq 1, the status event).
    const resumed = mockReq({
      auth: { tenantId: "tenant-a", userId: "u", role: "member" },
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
});
