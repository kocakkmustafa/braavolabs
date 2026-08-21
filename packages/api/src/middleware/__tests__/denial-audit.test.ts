/**
 * Refusals leave evidence (BR-P1-005 slice B).
 *
 * Slice A gave ActivityLog `result` and `policy` and wrote exactly one row:
 * a SUCCESSFUL export. Every other one of the 130 writers is also on a
 * success path, so the trail records what people were allowed to do and is
 * silent about what they were refused — including, absurdly, a refused
 * audit export.
 *
 * That is backwards. A permission gate produces its most valuable evidence at
 * the moment it FIRES. "Nobody has ever been refused anything" and "we never
 * wrote it down" are indistinguishable in today's trail, and only one of them
 * is good news.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const SECRET = "denial-audit-test-secret-at-least-32-chars";
const created: any[] = [];
let failWrites = false;
let failSynchronously = false;

vi.mock("../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../lib/db", () => ({
  prisma: {
    activityLog: {
      create: (args: any) => {
        // A SYNCHRONOUS throw, i.e. before any promise exists. `void
        // p.catch(h)` attaches its handler after create() returns, so this
        // shape bypassed it entirely and turned the deliberate 403 into a
        // 500 carrying an internal error string.
        if (failSynchronously) throw new Error("prisma threw synchronously");
        if (failWrites) return Promise.reject(new Error("db down"));
        created.push(args);
        return Promise.resolve({ id: "x" });
      },
    },
  },
  tenantTx: (fn: any) => fn({}),
}));
vi.mock("../../config/env", () => ({
  env: { JWT_SECRET: SECRET, AUTH_COOKIE_MODE: false, NODE_ENV: "test" },
}));

let server: http.Server;
let baseUrl: string;
const tok: Record<string, string> = {};

beforeAll(async () => {
  const jwt = (await import("jsonwebtoken")).default;
  for (const role of ["OWNER", "MEMBER"]) {
    tok[role] = jwt.sign({ userId: `u-${role}`, tenantId: "t1", role }, SECRET, { expiresIn: "1h" });
  }
  const { requirePermission } = await import("../require-permission");
  const { authMiddleware } = await import("../auth");

  const app = express();
  app.use(express.json());
  app.delete("/probe", authMiddleware, requirePermission("company:delete"), (_q, res) => {
    res.json({ ok: true });
  });
  // Mirrors governance's real shape: the identifier is in the URL but the
  // param is named `runId`, not `id`.
  app.post("/probe/:runId/stop", authMiddleware, requirePermission("governance:hard-stop"), (_q, res) => {
    res.json({ ok: true });
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function del(role?: string) {
  const res = await fetch(`${baseUrl}/probe`, {
    method: "DELETE",
    headers: role ? { Authorization: `Bearer ${tok[role]}` } : {},
  });
  // The write is fire-and-forget so the refusal is not delayed; give the
  // microtask queue a turn before asserting on it.
  await new Promise((r) => setTimeout(r, 10));
  return res.status;
}

describe("a refused privileged action leaves a row (BR-P1-005 slice B)", () => {
  it("records the refusal, with the outcome and the rule that produced it", async () => {
    created.length = 0;
    expect(await del("MEMBER")).toBe(403);
    expect(created.length, "a refusal must be recorded").toBe(1);

    const row = created[0].data;
    expect(row.result).toBe("denied");
    expect(row.policy).toBe("company:delete");
    expect(row.actor).toBe("u-MEMBER");
    expect(row.tenantId).toBe("t1");
    expect(typeof row.action).toBe("string");
  });

  it("writes exactly the sanctioned columns and nothing else", async () => {
    // A WHITELIST, not a blacklist. The previous version searched the
    // serialised row for "OWNER", which was both a tautology and actively
    // fragile: the probe actor is `u-MEMBER`, so a substring check over role
    // names fails for reasons that have nothing to do with a leak. And a
    // blacklist can only answer "did this exact string appear" — it would
    // never see `requiredRank: 3`.
    //
    // The property that actually matters is that nothing UNSANCTIONED is
    // written. The 403 body names the action and never the required role,
    // because that enumerates the privilege model; a row leaking it under
    // any key would undo that at the other end, since the export exists to
    // be read.
    created.length = 0;
    await del("MEMBER");
    expect(Object.keys(created[0].data).sort()).toEqual(
      ["action", "actor", "ip", "policy", "resource", "resourceId", "result", "tenantId"].sort(),
    );
  });

  it("records nothing when the action is ALLOWED — that is the success path's job", async () => {
    created.length = 0;
    expect(await del("OWNER")).toBe(200);
    expect(created.length, "the gate must not double-log allowed actions").toBe(0);
  });

  it("still refuses when the audit write itself fails", async () => {
    // Evidence must never become a way to get past the gate. If recording the
    // refusal could fail the request open, the log would be a bypass.
    failWrites = true;
    try {
      expect(await del("MEMBER")).toBe(403);
    } finally {
      failWrites = false;
    }
  });

  it("still refuses when the audit write throws SYNCHRONOUSLY", async () => {
    // The async case below was already covered; this shape was not, and it
    // was the one that escaped — producing a 500 with an internal error
    // string in place of the deliberate 403.
    failSynchronously = true;
    try {
      expect(await del("MEMBER")).toBe(403);
    } finally {
      failSynchronously = false;
    }
  });

  it("refuses an unauthenticated caller without inventing an actor", async () => {
    created.length = 0;
    expect(await del()).toBe(401);
    // No auth context means no tenant and no actor. Writing a row with a
    // fabricated actor would put a guess into the record an auditor trusts.
    expect(created.length).toBe(0);
  });
});

describe("the refusal names WHICH resource, whatever the param is called", () => {
  it("records a param that is not literally named `id`", async () => {
    // `params.id` alone recorded null on 10 of the 11 gates that can deny.
    // The one that stung was governance:hard-stop — "refused to hard-stop
    // which run" is precisely the fact an auditor wants, and the id was
    // sitting in the URL under the name `runId`.
    created.length = 0;
    const res = await fetch(`${baseUrl}/probe/run-42/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.MEMBER}` },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(res.status).toBe(403);
    expect(created[0].data.resourceId).toBe("run-42");
    expect(created[0].data.policy).toBe("governance:hard-stop");
  });

  it("records nothing rather than a truncated prefix", async () => {
    // A 64-char prefix of a longer value is a plausible-looking WRONG
    // identifier in an audit record — the same hazard the no-backfill
    // decision rejected. Absence is honest; a prefix is not.
    created.length = 0;
    const res = await fetch(`${baseUrl}/probe/${"x".repeat(200)}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.MEMBER}` },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(res.status).toBe(403);
    expect(created[0].data.resourceId).toBeNull();
  });
});
