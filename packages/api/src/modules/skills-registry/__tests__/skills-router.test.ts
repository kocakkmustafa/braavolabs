/**
 * Skill registry routes with a mocked Prisma: publish (proof, immutability, review vs
 * auto-approval), admin approve (signs), revoke (signed list) and a serious report.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const redisMock = vi.hoisted(() => ({ incr: vi.fn(), expire: vi.fn() }));
vi.mock("../../../lib/redis", () => ({ redis: redisMock }));
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

import { MAX_REVOCATIONS, _resetRevocationCache, publishLimiter, setSourceFetcher, skillsRegistryRouter } from "../skills.router";
import { frontmatter } from "../bundle";
import { verifyCanonical, publicKeyB64 } from "../signing";
import { makeTarGz, SKILL_MD } from "./tar-fixture";

const { privateKey } = generateKeyPairSync("ed25519");
process.env.SKILL_REGISTRY_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB = publicKeyB64(privateKey);

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
const repo = (proof = "acme", skill = SKILL_MD) => makeTarGz([{ path: "skills-v1/.braavo-publisher", content: proof }, { path: "skills-v1/SKILL.md", content: skill }]);
const publishBody = { name: "weekly-report", version: "1.0.0", repo: "acme/skills", ref: "v1" };

beforeEach(() => {
  for (const m of Object.values(db)) for (const f of Object.values(m)) (f as any).mockReset();
  db.activityLog.create.mockResolvedValue({});
  db.skillVersion.count.mockResolvedValue(0);
  db.skillPackage.create.mockImplementation(async ({ data }: any) => ({ id: "pkg1", ...data }));
  db.skillVersion.create.mockImplementation(async ({ data }: any) => ({ id: "ver1", ...data }));
  _resetRevocationCache();
});

describe("publish", () => {
  it("sends a new publisher's first version to review, unsigned", async () => {
    db.skillPublisher.findUnique.mockResolvedValue(publisher());
    setSourceFetcher(async () => repo());
    const { res, err } = await call("post", "/publish", { body: publishBody });
    expect(err).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ state: "NEEDS_REVIEW", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const data = db.skillVersion.create.mock.calls[0][0].data;
    expect(data.signature).toBeUndefined();
    expect(JSON.parse(data.bundle).files.map((f: any) => f.path)).toEqual(["SKILL.md"]);
  });

  it("auto-approves and signs a verified publisher's clean later version", async () => {
    db.skillPublisher.findUnique.mockResolvedValue(publisher({ verified: true }));
    db.skillPackage.findUnique.mockResolvedValue({ id: "pkg1", publisherId: "pub1" });
    db.skillVersion.findUnique.mockResolvedValue(null);
    db.skillVersion.count.mockImplementation(async ({ where }: any) => (where.state === "APPROVED" ? 3 : 0));
    setSourceFetcher(async () => repo());
    const { res } = await call("post", "/publish", { body: { ...publishBody, version: "1.1.0" } });
    expect(res.body.state).toBe("APPROVED");
    const data = db.skillVersion.create.mock.calls[0][0].data;
    expect(verifyCanonical(data.signedManifest, data.signature, PUB)).toBe(true);
    expect(JSON.parse(data.signedManifest)).toMatchObject({ name: "weekly-report", version: "1.1.0", publisher: "acme", trust: "VERIFIED", sha256: data.sha256 });
  });

  it("refuses without the repository proof, another publisher's name, a reused version, or a suspended publisher", async () => {
    db.skillPublisher.findUnique.mockResolvedValue(publisher());
    setSourceFetcher(async () => repo("someone-else"));
    expect((await call("post", "/publish", { body: publishBody })).err?.statusCode).toBe(403);
    db.skillPackage.findUnique.mockResolvedValue({ id: "pkg1", publisherId: "other" });
    expect((await call("post", "/publish", { body: publishBody })).err?.message).toMatch(/another publisher/);
    db.skillPackage.findUnique.mockResolvedValue({ id: "pkg1", publisherId: "pub1" });
    db.skillVersion.findUnique.mockResolvedValue({ id: "v0" });
    expect((await call("post", "/publish", { body: publishBody })).err?.statusCode).toBe(409);
    db.skillPublisher.findUnique.mockResolvedValue(publisher({ status: "SUSPENDED" }));
    expect((await call("post", "/publish", { body: publishBody })).err?.message).toMatch(/suspended/);
    expect(db.skillVersion.create).not.toHaveBeenCalled();
  });

  it("rejects a bundle that blocks (name mismatch) and turns archive errors into 422", async () => {
    db.skillPublisher.findUnique.mockResolvedValue(publisher({ verified: true }));
    setSourceFetcher(async () => repo("acme", SKILL_MD.replace("name: weekly-report", "name: other")));
    expect((await call("post", "/publish", { body: publishBody })).res.body.state).toBe("REJECTED");
    setSourceFetcher(async () => makeTarGz([{ path: "r/.braavo-publisher", content: "acme" }, { path: "r/notes.md", content: "x" }]));
    expect((await call("post", "/publish", { body: publishBody })).err?.statusCode).toBe(422);
  });
});

describe("moderation", () => {
  const pending = { id: "ver1", packageId: "pkg1", version: "1.0.0", sha256: "a".repeat(64), state: "NEEDS_REVIEW", files: [{ path: "SKILL.md", size: 10, sha256: "b".repeat(64) }], package: { name: "weekly-report", publisherId: "pub1", publisher: publisher() } };

  it("only admins approve; approval signs the manifest as COMMUNITY", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@yulalab.com";
    db.user.findUnique.mockResolvedValue({ email: "someone@x.com" });
    expect((await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } })).err?.statusCode).toBe(403);
    db.user.findUnique.mockResolvedValue({ email: "admin@yulalab.com", emailVerifiedAt: new Date() });
    db.skillVersion.findFirst.mockResolvedValue(pending);
    db.skillVersion.update.mockResolvedValue({}); db.skillPackage.update.mockResolvedValue({}); db.skillReport.updateMany.mockResolvedValue({});
    const { res } = await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } });
    expect(res.body).toEqual({ state: "APPROVED" });
    const data = db.skillVersion.update.mock.calls[0][0].data;
    expect(verifyCanonical(data.signedManifest, data.signature, PUB)).toBe(true);
    expect(JSON.parse(data.signedManifest).trust).toBe("COMMUNITY");
  });

  it("a revocation lands in the signed public list", async () => {
    db.user.findUnique.mockResolvedValue({ email: "admin@yulalab.com", emailVerifiedAt: new Date() });
    db.skillVersion.findFirst.mockResolvedValue({ ...pending, state: "APPROVED" });
    db.skillVersion.update.mockResolvedValue({}); db.skillRevocation.create.mockResolvedValue({}); db.skillReport.updateMany.mockResolvedValue({});
    expect((await call("post", "/:name/versions/:version/revoke", { params: { name: "weekly-report", version: "1.0.0" }, body: { reason: "exfiltrates notes" } })).res.body).toEqual({ state: "REVOKED" });
    db.skillRevocation.findMany.mockResolvedValue([{ name: "weekly-report", version: "1.0.0", sha256: "a".repeat(64), reason: "exfiltrates notes", createdAt: new Date("2026-11-02T10:00:00Z") }]);
    const { res } = await call("get", "/revocations", {});
    expect(res.body.entries).toEqual([{ name: "weekly-report", version: "1.0.0", sha256: "a".repeat(64), reason: "exfiltrates notes", revokedAt: "2026-11-02T10:00:00.000Z" }]);
    expect(verifyCanonical(res.body.signedList, res.body.signature, PUB)).toBe(true);
    expect(JSON.parse(res.body.signedList).entries).toEqual(res.body.entries);
  });

  it("a serious report pulls an unverified publisher's version from the catalog", async () => {
    db.skillReport.count.mockResolvedValue(0);
    db.skillVersion.findFirst.mockResolvedValue({ ...pending, state: "APPROVED" });
    db.skillReport.create.mockResolvedValue({ id: "r1" });
    db.skillVersion.update.mockResolvedValue({});
    const { res } = await call("post", "/:name/report", { params: { name: "weekly-report" }, body: { severity: "HIGH", reason: "asks to send keys" } });
    expect(res.body).toEqual({ id: "r1", pulled: true });
    expect(db.skillVersion.update).toHaveBeenCalledWith({ where: { id: "ver1", state: "APPROVED" }, data: { state: "NEEDS_REVIEW" } });
  });

  it("an allow-listed address without a verified e-mail is refused (403), case-insensitively", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = " Admin@YulaLab.com ";
    db.user.findUnique.mockResolvedValue({ email: "admin@yulalab.com", emailVerifiedAt: null });
    expect((await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } })).err?.statusCode).toBe(403);
    db.user.findUnique.mockResolvedValue({ email: "ADMIN@yulalab.com", emailVerifiedAt: new Date() });
    db.skillVersion.findFirst.mockResolvedValue(pending);
    db.skillVersion.update.mockResolvedValue({}); db.skillPackage.update.mockResolvedValue({}); db.skillReport.updateMany.mockResolvedValue({});
    expect((await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } })).res.body).toEqual({ state: "APPROVED" });
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@yulalab.com";
  });

  it("approving a version that changed state meanwhile is a 409 and the update is state-conditional", async () => {
    db.user.findUnique.mockResolvedValue({ email: "admin@yulalab.com", emailVerifiedAt: new Date() });
    db.skillVersion.findFirst.mockResolvedValue(pending);
    db.skillVersion.update.mockRejectedValue({ code: "P2025" }); db.skillPackage.update.mockResolvedValue({}); db.skillReport.updateMany.mockResolvedValue({});
    const { err } = await call("post", "/:name/versions/:version/approve", { params: { name: "weekly-report", version: "1.0.0" } });
    expect(err?.statusCode).toBe(409);
    expect(db.skillVersion.update.mock.calls[0][0].where).toEqual({ id: "ver1", state: "NEEDS_REVIEW" });
  });

  it("refuses to sign a truncated revocation list (503) and signs count and version otherwise", async () => {
    db.skillRevocation.findMany.mockResolvedValue(Array.from({ length: MAX_REVOCATIONS + 1 }, (_, i) => ({ name: "n" + i, version: "1.0.0", sha256: "a".repeat(64), reason: "r", createdAt: new Date() })));
    expect((await call("get", "/revocations", {})).err?.statusCode).toBe(503);
    _resetRevocationCache();
    db.skillRevocation.findMany.mockResolvedValue([]);
    const { res } = await call("get", "/revocations", {});
    expect(JSON.parse(res.body.signedList)).toMatchObject({ version: 1, count: 0, entries: [] });
  });
});

describe("hardening", () => {
  it("frontmatter parses a pathological whitespace line and rejects bad keys (no wall-clock assertion)", () => {
    const md = "---\nk:" + " ".repeat(64_000) + "x \n---\nbody";
    expect(frontmatter(md)).toEqual({ k: "x" });
    expect(frontmatter("---\nname: demo\ndescription: \"hi there\"\n---\n")).toEqual({ name: "demo", description: "hi there" });
    expect(frontmatter("---\n__proto__: x\n1bad: y\n :z\nok-key: v\n---\n")).toEqual({ "ok-key": "v" });
  });

  it("publish is rate limited per user, counting every attempt", async () => {
    const route = (skillsRegistryRouter as any).stack.flatMap((l: any) => l.handle?.stack ?? []).find((l: any) => l.route?.path === "/publish" && l.route.methods.post);
    expect(route.route.stack.length).toBe(2); // limiter + handler
    expect(route.route.stack[0].handle).toBe(publishLimiter);
    redisMock.incr.mockResolvedValue(31); redisMock.expire.mockResolvedValue(1);
    const res: any = { setHeader() {}, status(c: number) { this.code = c; return this; }, json() { return this; } };
    const next = vi.fn();
    await publishLimiter({ auth: { tenantId: "t1", userId: "u1" } } as any, res, next);
    expect(res.code).toBe(429);
    expect(next).not.toHaveBeenCalled();
    expect(redisMock.incr.mock.calls.at(-1)![0]).toBe("rl:skills:publish:u1");
  });

  it("publish limiter fails CLOSED (503) when Redis is down", async () => {
    redisMock.incr.mockRejectedValue(new Error("redis down"));
    const res: any = { setHeader() {}, status(c: number) { this.code = c; return this; }, json() { return this; } };
    const next = vi.fn();
    await publishLimiter({ auth: { tenantId: "t1", userId: "u1" } } as any, res, next);
    expect(res.code).toBe(503);
    expect(next).not.toHaveBeenCalled();
    redisMock.incr.mockReset();
  });
});
