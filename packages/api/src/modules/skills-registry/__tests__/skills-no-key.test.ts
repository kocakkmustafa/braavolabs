/**
 * Skill registry with NO signing key and NO admin list configured: must fail closed
 * (never an unsigned approval, never a made-up signed list, never a crash on import).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));

const db = vi.hoisted(() => {
  const fn = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() });
  return { skillPublisher: fn(), skillPackage: fn(), skillVersion: fn(), skillReport: fn(), skillRevocation: fn(), user: fn(), activityLog: fn() };
});
vi.mock("../../../lib/db", () => ({
  prisma: {
    ...db,
    $transaction: async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: typeof db) => unknown)(db) : Promise.all(arg as unknown[])),
  },
}));

import { _resetRevocationCache, setSourceFetcher, skillsRegistryRouter } from "../skills.router";
import { makeTarGz, SKILL_MD } from "./tar-fixture";

// This file never sets SKILL_REGISTRY_PRIVATE_KEY or MARKETPLACE_ADMIN_EMAILS: production has neither yet.
delete process.env.SKILL_REGISTRY_PRIVATE_KEY;
delete process.env.MARKETPLACE_ADMIN_EMAILS;

function handler(router: Router, method: string, path: string) {
  const stacks: any[] = [(router as any).stack];
  while (stacks.length) {
    for (const layer of stacks.shift()) {
      if (layer.route?.path === path && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
      if (layer.handle?.stack) stacks.push(layer.handle.stack);
    }
  }
  throw new Error(`no route ${method} ${path}`);
}
async function call(method: string, path: string, req: Record<string, unknown>) {
  const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  let err: any;
  await handler(skillsRegistryRouter, method, path)({ auth: { tenantId: "t1", userId: "u1" }, params: {}, body: {}, query: {}, ...req }, res, (e: unknown) => { err = e; });
  return { res, err };
}

const publisher = (over: Record<string, unknown> = {}) => ({ id: "pub1", userId: "u1", handle: "acme", verified: false, official: false, status: "ACTIVE", strikes: 0, ...over });
const repo = () => makeTarGz([{ path: "skills-v1/.braavo-publisher", content: "acme" }, { path: "skills-v1/SKILL.md", content: SKILL_MD }]);
const publishBody = { name: "weekly-report", version: "1.1.0", repo: "acme/skills", ref: "v1" };

beforeEach(() => {
  for (const m of Object.values(db)) for (const f of Object.values(m)) (f as any).mockReset();
  db.activityLog.create.mockResolvedValue({});
  db.skillVersion.count.mockResolvedValue(0);
  db.skillPackage.create.mockImplementation(async ({ data }: any) => ({ id: "pkg1", ...data }));
  db.skillVersion.create.mockImplementation(async ({ data }: any) => ({ id: "ver1", ...data }));
  _resetRevocationCache();
});

describe("no signing key, no admin list", () => {
  it("a verified publisher's clean version is NOT auto-approved and nothing is signed", async () => {
    db.skillPublisher.findUnique.mockResolvedValue(publisher({ verified: true }));
    db.skillPackage.findUnique.mockResolvedValue({ id: "pkg1", publisherId: "pub1" });
    db.skillVersion.findUnique.mockResolvedValue(null);
    db.skillVersion.count.mockImplementation(async ({ where }: any) => (where.state === "APPROVED" ? 3 : 0));
    setSourceFetcher(async () => repo());
    const { res, err } = await call("post", "/publish", { body: publishBody });
    expect(err).toBeUndefined();
    expect(res.body.state).toBe("NEEDS_REVIEW");
    const data = db.skillVersion.create.mock.calls[0][0].data;
    expect(data.signature).toBeUndefined();
    expect(data.signedManifest).toBeUndefined();
  });

  it("approve is 403 for everyone without an admin list, and 503 for an admin when the key is missing", async () => {
    db.user.findUnique.mockResolvedValue({ email: "admin@yulalab.com" });
    expect((await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } })).err?.statusCode).toBe(403);
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@yulalab.com";
    try {
      expect((await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } })).err?.statusCode).toBe(503);
      expect(db.skillVersion.update).not.toHaveBeenCalled();
    } finally { delete process.env.MARKETPLACE_ADMIN_EMAILS; }
  });

  it("GET /revocations is 503, never a made-up signed empty list", async () => {
    db.skillRevocation.findMany.mockResolvedValue([]);
    const { res, err } = await call("get", "/revocations", {});
    expect(err?.statusCode).toBe(503);
    expect(res.body).toBeUndefined();
  });
});
