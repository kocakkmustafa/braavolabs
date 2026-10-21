/** Opt-in acceptance against an ALREADY prepared disposable PostgreSQL database.
 * This suite does not create a database/role, apply migrations, grant rights,
 * start a listener or send notifications. Missing setup is an explicit SKIP.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const probeUrl = process.env.F02_DATABASE_URL;
const enabled = Boolean(probeUrl && process.env.F02_DATABASE_IS_DISPOSABLE === "1");
it("requires the real database matrix when the dedicated acceptance gate requests it", () => {
  if (process.env.REQUIRE_F02_DATABASE_MATRIX === "1") expect(enabled,
    "Supply F02_DATABASE_URL and F02_DATABASE_IS_DISPOSABLE=1 for an already prepared disposable RLS database").toBe(true);
});

(enabled ? describe : describe.skip)("push ownership — real PostgreSQL/RLS acceptance", () => {
  let db: typeof import("./db");
  let ownership: typeof import("./pushOwnership");
  let context: typeof import("./tenant-context");
  const suffix = randomUUID();
  const tenants = [`f02-a-${suffix}`, `f02-b-${suffix}`];
  const users = [`f02-ua-${suffix}`, `f02-ub-${suffix}`];
  let a: import("./pushOwnership").PushActor;
  let b: import("./pushOwnership").PushActor;
  const hashes = new Set<string>();
  const token = () => `ExponentPushToken[f02-${randomUUID()}]`;
  const inActor = <T>(actor: import("./pushOwnership").PushActor, fn: () => T) => context.runWithTenant(actor.tenantId, fn);
  const system = <T>(fn: () => T) => context.runWithoutTenant("test:f02-disposable-acceptance", fn);
  const register = (actor: import("./pushOwnership").PushActor, value: string, revision = 1) => {
    hashes.add(ownership.tokenDigest(value));
    return inActor(actor, () => ownership.registerPushDevice(actor, { token: value, revision, platform: "ios", locale: "en" }));
  };
  beforeAll(async () => {
    process.env.DATABASE_URL = probeUrl!;
    process.env.JWT_SECRET ||= "f02-disposable-probe-secret-over-32-chars";
    process.env.ENCRYPTION_KEY ||= "0".repeat(32);
    db = await import("./db"); context = await import("./tenant-context"); ownership = await import("./pushOwnership");
    // A bypass/owner role would turn a green tenant test into false RLS proof.
    const roles = await system(() => db.tenantTx(tx => tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean; rls: boolean }>>`
      SELECT r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, c.relowner, 'USAGE') AS owns, c.relrowsecurity AS rls
      FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname = current_user AND n.nspname = 'public' AND c.relname IN ('devices', 'push_sessions')`));
    expect(roles).toHaveLength(2);
    for (const role of roles) expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owns: false, rls: true });
    await system(async () => {
      for (let i = 0; i < 2; i++) {
        await db.prisma.tenant.create({ data: { id: tenants[i]!, slug: tenants[i]!, name: `F02 disposable ${i}` } });
        await db.prisma.user.create({ data: { id: users[i]!, tenantId: tenants[i]!, email: `${users[i]}@probe.invalid`, passwordHash: "test-only", name: "F02 probe", role: "OWNER" } });
      }
    });
  });
  beforeEach(async () => {
    a = { userId: users[0]!, tenantId: tenants[0]!, pushSessionId: randomUUID() };
    b = { userId: users[1]!, tenantId: tenants[1]!, pushSessionId: randomUUID() };
    for (const actor of [a, b]) expect(await system(() => ownership.createPushSession(actor, actor.pushSessionId!, new Date(Date.now() + 60_000)))).toBe(true);
  });
  afterAll(async () => {
    if (!db || !context) return;
    await system(async () => {
      for (const hash of hashes) await db.tenantTx(tx => tx.$executeRaw`DELETE FROM push_token_fences WHERE token_hash = ${hash}`);
      await db.prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });
  it("transfers across RLS tenants; delayed/duplicate A requests cannot take B back", async () => {
    const value = token(); await register(a, value); await register(b, value);
    await expect(register(a, value, 2)).rejects.toMatchObject({ statusCode: 409 });
    await expect(register(a, value)).rejects.toMatchObject({ statusCode: 409 });
    expect(await inActor(a, () => ownership.currentPushDevices(a.userId))).toEqual([]);
    expect(await inActor(b, () => ownership.currentPushDevices(b.userId))).toHaveLength(1);
    // Both tenant rows survive; B's transfer never edits A's RLS-owned row.
    const ownCount = (actor: typeof a) => inActor(actor, () => db.tenantTx(tx => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM devices WHERE push_token = ${value}`));
    expect((await ownCount(a))[0]!.n).toBe(1n); expect((await ownCount(b))[0]!.n).toBe(1n);
  });
  it("revokes before registration and cannot renew/recreate retired authority", async () => {
    await inActor(a, () => ownership.retirePushSession(a));
    await expect(register(a, token())).rejects.toMatchObject({ statusCode: 409 });
    expect(await system(() => ownership.renewPushSession(a, a.pushSessionId!, new Date(Date.now() + 120_000)))).toBe(false);
  });
  it("keeps duplicates idempotent after locale PATCH and rejects conflicting revision reuse", async () => {
    const value = token(); await register(b, value);
    expect(await inActor(b, () => ownership.updatePushDeviceLocale(b, value, 1, "tr"))).toBe(true);
    await register(b, value);
    expect((await inActor(b, () => ownership.currentPushDevices(b.userId))).find(d => d.pushToken === value)?.locale).toBe("tr");
    await expect(inActor(b, () => ownership.registerPushDevice(b, { token: value, platform: "ios", revision: 1, locale: "ar" }))).rejects.toMatchObject({ statusCode: 409 });
    await register(b, value, 2);
  });
  it("drops a stale queued delivery, and serializes provider handoff before a concurrent transfer completes", async () => {
    const value = token(); await register(a, value);
    const snapshot = (await inActor(a, () => ownership.currentPushDevices(a.userId))).filter(d => d.pushToken === value);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
    const events: string[] = [];
    const send = inActor(a, () => ownership.withCurrentPushDelivery(snapshot, async () => { entered(); await gate; events.push("provider-complete"); return []; }));
    await started;
    const transfer = register(b, value).then(() => { events.push("transfer-complete"); });
    release(); await Promise.all([send, transfer]);
    expect(events).toEqual(["provider-complete", "transfer-complete"]);
    let called = false;
    await inActor(a, () => ownership.withCurrentPushDelivery(snapshot, async () => { called = true; return []; }));
    expect(called).toBe(false);
  });
  it("prunes exact delivery snapshots but retains the owner fence against replay", async () => {
    const value = token(); await register(a, value); await register(b, value);
    const snapshot = (await inActor(b, () => ownership.currentPushDevices(b.userId))).filter(d => d.pushToken === value);
    await inActor(b, () => ownership.withCurrentPushDelivery(snapshot, async live => live));
    await expect(register(a, value, 2)).rejects.toMatchObject({ statusCode: 409 });
    await expect(register(b, value)).rejects.toMatchObject({ statusCode: 409 });
    await register(b, value, 2); // Legitimate fresh registration remains possible.
  });
});
