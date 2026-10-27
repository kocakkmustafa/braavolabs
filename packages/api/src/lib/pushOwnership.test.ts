/**
 * Synthetic proof of the real adapter's SQL/control flow. No Prisma connection,
 * provider request, listener, credentials, native tool, or shared cache is used.
 * PostgreSQL privileges, migrations, and actual RLS remain a separate gate.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ tenantTx: vi.fn() }));
vi.mock("./db", () => db);
vi.mock("../middleware/error", () => ({
  AppError: class extends Error {
    constructor(public statusCode: number, message: string) { super(message); }
  },
}));
import {
  createPushSession, currentPushDevices, registerPushDevice, renewPushSession,
  retirePushSession, tokenDigest, unregisterLegacyPushDevice, updatePushDeviceLocale,
  withCurrentPushDelivery, type PushActor, type PushDevice, type PushRegistration,
} from "./pushOwnership";
import { runWithTenant, runWithoutTenant } from "./tenant-context";
import { latch, PushSqlStore, SQL } from "./__tests__/pushOwnership.fixture";

let store: PushSqlStore;
const A: PushActor = { userId: "user-A", tenantId: "tenant-A", pushSessionId: "login-A" };
const B: PushActor = { userId: "user-B", tenantId: "tenant-B", pushSessionId: "login-B" };
const token = "ExponentPushToken[synthetic-installation]";
const input = (revision = 1, locale = "en", pushToken = token): PushRegistration => ({
  token: pushToken, revision, locale, platform: "ios", deviceName: "synthetic phone", osVersion: "synthetic-os",
});
const as = <T>(actor: PushActor, fn: () => T): T => runWithTenant(actor.tenantId, fn);
const auth = <T>(fn: () => T): T => runWithoutTenant("test:push-auth", fn);
const register = (actor: PushActor, registration = input()) => as(actor, () => registerPushDevice(actor, registration));
const retire = (actor: PushActor) => as(actor, () => retirePushSession(actor));
const devices = (actor: PushActor) => as(actor, () => currentPushDevices(actor.userId));
const deliver = (actor: PushActor, snapshots: PushDevice[], send: (live: PushDevice[]) => Promise<PushDevice[]>) =>
  as(actor, () => withCurrentPushDelivery(snapshots, send));
const changed = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ statusCode: 409 });
async function login(actor: PushActor, expiresAt = store.expiry()) {
  store.addUser(actor);
  expect(await auth(() => createPushSession(actor, actor.pushSessionId!, expiresAt))).toBe(true);
}

beforeEach(() => {
  store = new PushSqlStore();
  db.tenantTx.mockReset().mockImplementation(store.transaction);
  let id = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
});
afterEach(() => vi.restoreAllMocks());

describe("push ownership adapter — parameterized synthetic SQL model", () => {
  it("never stores the user-set device name a legacy client still sends", async () => {
    await login(A);
    await register(A);
    const [row] = [...store.devices.values()];
    expect(row).toMatchObject({ deviceName: null, osVersion: "synthetic-os", platform: "ios" });
  });
  it("pins the canonical user before the session to match account-erasure FK lock order", async () => {
    await login(A); store.trace.length = 0;
    await register(A);
    expect(store.trace.slice(0, 2).map(t => t.sql)).toEqual([SQL.userLock, SQL.session]);
  });
  it("denies delayed A POST, retries, and exact duplicates after B claims the same token across tenants", async () => {
    await login(A); await login(B);
    await register(A);
    const oldA = (await devices(A))[0];
    const aRow = { ...store.devices.get(oldA.id)! };
    await register(B, input(1, "tr"));
    await changed(register(A));
    await changed(register(A, input(2)));
    await changed(register(A, input(2)));
    expect(await devices(A)).toEqual([]);
    expect(await devices(B)).toEqual([expect.objectContaining({ userId: B.userId, locale: "tr" })]);
    expect(store.devices.get(oldA.id)).toEqual(aRow);
    expect(store.fences.get(tokenDigest(token))).toMatchObject({ sessionId: B.pushSessionId, revision: 1 });
    const bWrites = store.trace.filter(t => t.context.kind === "tenant" && t.context.tenantId === B.tenantId
      && [SQL.advanceSession, SQL.deletePrevious, SQL.upsert].includes(t.sql));
    expect(bWrites).toHaveLength(3);
    expect(bWrites.every(t => t.parameters.includes(B.userId) && !t.parameters.includes(A.userId))).toBe(true);
  });

  it("denies an initial A POST that first arrives after newer B registration", async () => {
    await login(A); await login(B);
    await register(B);
    await changed(register(A));
    expect(store.sessions.get(A.pushSessionId!)!.revision).toBe(0);
    expect(await devices(B)).toHaveLength(1);
  });

  it("retires authority before token acquisition/POST and refresh cannot recreate it", async () => {
    await login(A);
    await retire(A);
    await changed(register(A));
    expect(await auth(() => renewPushSession(A, A.pushSessionId!, store.expiry()))).toBe(false);
    expect(store.sessions.has(A.pushSessionId!)).toBe(false);
    expect(store.devices.size).toBe(0);
    expect(store.fences.size).toBe(0);
  });

  it("serializes registration first, then retirement cascades the newly registered row", async () => {
    await login(A);
    const gate = store.holdNext(SQL.session);
    const registering = register(A);
    await gate.entered;
    const blocked = store.blockedOn(`session:${A.pushSessionId}`);
    const retiring = retire(A);
    await blocked;
    expect(store.sessions.has(A.pushSessionId!)).toBe(true);
    gate.release();
    await expect(registering).resolves.toEqual({ success: true, revision: 1 });
    await retiring;
    expect(store.sessions.has(A.pushSessionId!)).toBe(false);
    expect(store.devices.size).toBe(0);
    await changed(register(A, input(2)));
  });

  it("serializes retirement first, then rejects registration after its session lock wait", async () => {
    await login(A);
    const gate = store.holdNext(SQL.retireLock);
    const retiring = retire(A);
    await gate.entered;
    const blocked = store.blockedOn(`session:${A.pushSessionId}`);
    const registering = register(A);
    const denied = changed(registering);
    await blocked;
    gate.release();
    await retiring; await denied;
    expect(store.sessions.size).toBe(0);
    expect(store.devices.size).toBe(0);
  });

  it("enforces monotonic revisions and ACKs an exact duplicate without overwriting a later locale PATCH", async () => {
    await login(A);
    const first = input();
    await register(A, first);
    expect(await as(A, () => updatePushDeviceLocale(A, token, 1, "fr"))).toBe(true);
    await expect(register(A, first)).resolves.toEqual({ success: true, revision: 1 });
    expect((await devices(A))[0].locale).toBe("fr");
    await changed(register(A, input(1, "de")));
    await changed(register(A, input(0)));
    await register(A, input(2, "tr", "ExponentPushToken[rotated]"));
    expect(await as(A, () => updatePushDeviceLocale(A, token, 1, "ar"))).toBe(false);
    expect(await as(A, () => updatePushDeviceLocale(A, "ExponentPushToken[rotated]", 1, "ar"))).toBe(false);
    expect(await devices(A)).toEqual([expect.objectContaining({ pushToken: "ExponentPushToken[rotated]", pushRevision: 2, locale: "tr" })]);
    expect(store.devices.size).toBe(1);
  });

  it("keeps stale PATCH and legacy DELETE scoped after transfer, excluding all legacy rows from current devices", async () => {
    await login(A); await login(B);
    const legacyA = store.legacy(A.userId, token), legacyB = store.legacy(B.userId, token);
    await register(A); await register(B, input(1, "ja"));
    expect(await as(A, () => updatePushDeviceLocale(A, token, 1, "fr"))).toBe(false);
    await as(A, () => unregisterLegacyPushDevice(A, token));
    expect(store.devices.has(legacyA)).toBe(false);
    expect(store.devices.has(legacyB)).toBe(true);
    expect(await devices(A)).toEqual([]);
    const b = await devices(B);
    expect(b).toEqual([expect.objectContaining({ pushSessionId: B.pushSessionId, locale: "ja" })]);
    await as(B, () => unregisterLegacyPushDevice(B, token));
    expect(await devices(B)).toEqual(b);
    expect(store.devices.size).toBe(2); // A's ineligible managed row and B's managed row.
    await retire(A);
    expect(await devices(B)).toEqual(b);
    expect(store.devices.size).toBe(1);
    expect(store.fences.get(tokenDigest(token))!.sessionId).toBe(B.pushSessionId);
  });

  it("orders same-user relogin by server login order, denying the older session", async () => {
    const relogin = { ...A, pushSessionId: "login-A-again" };
    await login(A); await register(A);
    await login(relogin); await register(relogin, input(1, "ko"));
    await changed(register(A, input(20)));
    expect(await as(A, () => updatePushDeviceLocale(A, token, 1, "fr"))).toBe(false);
    expect(await devices(A)).toEqual([expect.objectContaining({ pushSessionId: relogin.pushSessionId, locale: "ko" })]);
  });

  it("lets a fresh authenticated login reclaim ownership after the newer owner retires", async () => {
    await login(A); await login(B); await register(B); await retire(B);
    await changed(register(A));
    const newA = { ...A, pushSessionId: "login-A-new-authority" };
    await login(newA); await register(newA, input(1, "pl"));
    expect(await devices(newA)).toEqual([expect.objectContaining({ pushSessionId: newA.pushSessionId, locale: "pl" })]);
  });

  it("retains a retired B fence while older A is live, then collects it only after A expires without resurrection", async () => {
    await login(A, store.expiry(10));
    await login(B); await register(B);
    const previousOrder = store.sessions.get(B.pushSessionId!)!.loginOrder;
    await retire(B);
    expect(await auth(() => renewPushSession(B, B.pushSessionId!, store.expiry()))).toBe(false);
    expect(store.fences.get(tokenDigest(token))).toMatchObject({ sessionId: B.pushSessionId, loginOrder: previousOrder });
    await changed(register(A));
    store.now += 10;
    expect(await auth(() => renewPushSession(A, A.pushSessionId!, store.expiry()))).toBe(false);
    expect(store.sessions.has(A.pushSessionId!)).toBe(false);
    expect(store.fences.has(tokenDigest(token))).toBe(false);
    const freshB = { ...B, pushSessionId: "login-B-after-safe-gc" };
    await login(freshB);
    expect(store.sessions.get(freshB.pushSessionId)!.loginOrder).toBeGreaterThan(previousOrder);
    await register(freshB);
    expect(await devices(freshB)).toEqual([expect.objectContaining({ pushSessionId: freshB.pushSessionId })]);
    const collection = store.trace.filter(t => t.sql === SQL.gcFences);
    expect(collection.length).toBeGreaterThan(0);
    expect(collection.every(t => t.context.kind === "system")).toBe(true);
  });

  it("never invokes delivery for an A snapshot after B transfer has completed", async () => {
    await login(A); await login(B); await register(A);
    const snapshots = await devices(A);
    await register(B);
    const send = vi.fn(async () => []);
    await deliver(A, snapshots, send);
    expect(send).not.toHaveBeenCalled();
    expect(await devices(B)).toHaveLength(1);
  });

  it("holds the delivery fence throughout the callback, so B transfer waits until dispatch completes", async () => {
    await login(A); await login(B); await register(A);
    const snapshots = await devices(A), entered = latch(), release = latch();
    const send = vi.fn(async (live: PushDevice[]) => {
      expect(live).toEqual(snapshots);
      entered.resolve();
      await release.promise;
      expect(store.fences.get(tokenDigest(token))!.sessionId).toBe(A.pushSessionId);
      return [];
    });
    const delivery = deliver(A, snapshots, send);
    await entered.promise;
    const blocked = store.blockedOn(`fence:${tokenDigest(token)}`);
    let transferred = false;
    const transfer = register(B).then(() => { transferred = true; });
    await blocked;
    expect(transferred).toBe(false);
    release.resolve();
    await delivery; await transfer;
    expect(send).toHaveBeenCalledOnce();
    expect(transferred).toBe(true);
    expect(await devices(A)).toEqual([]);
    expect(await devices(B)).toHaveLength(1);
  });

  it("holds the delivery session lock throughout the callback, so retirement waits", async () => {
    await login(A); await register(A);
    const entered = latch(), release = latch();
    const delivery = deliver(A, await devices(A), async () => { entered.resolve(); await release.promise; return []; });
    await entered.promise;
    const blocked = store.blockedOn(`session:${A.pushSessionId}`);
    const retiring = retire(A);
    await blocked;
    expect(store.sessions.has(A.pushSessionId!)).toBe(true);
    release.resolve();
    await delivery; await retiring;
    expect(store.sessions.has(A.pushSessionId!)).toBe(false);
    expect(store.devices.size).toBe(0);
  });

  it("prunes only an exact dead-device tuple, retains the fence, denies A replay, and permits B's next revision", async () => {
    await login(A); await login(B); await register(A); await register(B);
    const [b] = await devices(B);
    for (const wrong of [
      { ...b, id: "other-device" }, { ...b, userId: A.userId },
      { ...b, pushSessionId: A.pushSessionId! }, { ...b, pushRevision: 0 },
    ]) {
      await deliver(B, [b], async () => [wrong]);
      expect(store.devices.has(b.id)).toBe(true);
    }
    await deliver(B, [b], async live => live);
    expect(store.devices.has(b.id)).toBe(false);
    expect(store.fences.get(tokenDigest(token))).toMatchObject({ sessionId: B.pushSessionId, revision: 1 });
    await changed(register(A, input(99)));
    await changed(register(B)); // Exact ACK requires the still-existing registration row.
    await register(B, input(2, "id"));
    expect(await devices(B)).toEqual([expect.objectContaining({ pushRevision: 2, locale: "id" })]);
  });

  it("rechecks wall-clock expiry after waiting for a delivery-held fence", async () => {
    await login(B); await register(B);
    const lateA = { ...A, pushSessionId: "short-login-A" };
    await login(lateA, store.expiry(10));
    const entered = latch(), release = latch();
    const delivery = deliver(B, await devices(B), async () => { entered.resolve(); await release.promise; return []; });
    await entered.promise;
    const blocked = store.blockedOn(`fence:${tokenDigest(token)}`);
    const registering = register(lateA);
    const denied = changed(registering);
    await blocked;
    store.now += 11;
    release.resolve();
    await delivery; await denied;
    expect(store.sessions.get(lateA.pushSessionId)!.revision).toBe(0);
    expect(store.fences.get(tokenDigest(token))!.sessionId).toBe(B.pushSessionId);
  });

  it("denies wrong actor, wrong tenant, expired session, and deleted-user authority", async () => {
    await login(A); await login(B);
    await register(A);
    await changed(register({ ...B, pushSessionId: A.pushSessionId }));
    await changed(register({ ...A, tenantId: B.tenantId }));
    const expiry = store.sessions.get(A.pushSessionId!)!.expiresAt;
    store.now = expiry;
    await changed(register(A));
    expect(await devices(A)).toEqual([]);
    expect(await as(A, () => renewPushSession(A, A.pushSessionId!, store.expiry()))).toBe(false);
    store.now = expiry - 1;
    store.deleteUser(A.userId);
    await changed(register(A));
    expect(await as(A, () => renewPushSession(A, A.pushSessionId!, store.expiry()))).toBe(false);
    expect(await devices(A)).toEqual([]);
    expect(await auth(() => createPushSession({ userId: B.userId, tenantId: A.tenantId }, "wrong-tenant-login", store.expiry()))).toBe(false);
    expect(store.sessions.has("wrong-tenant-login")).toBe(false);
  });

  it("refresh extends only live existing authority, preserves order/revision, and cannot insert a missing session", async () => {
    await login(A); await register(A);
    const before = { ...store.sessions.get(A.pushSessionId!)! };
    expect(await as(A, () => renewPushSession(A, A.pushSessionId!, store.expiry(120_000)))).toBe(true);
    expect(store.sessions.get(A.pushSessionId!)).toEqual({ ...before, expiresAt: store.now + 120_000 });
    expect(await as(A, () => renewPushSession(A, "never-created", store.expiry()))).toBe(false);
    expect(store.sessions.has("never-created")).toBe(false);
    expect(store.trace.filter(t => t.sql === SQL.create)).toHaveLength(1);
    await retire(A);
    expect(await as(A, () => renewPushSession(A, A.pushSessionId!, store.expiry()))).toBe(false);
    expect(store.sessions.has(A.pushSessionId!)).toBe(false);
  });

  it("takes the global authority/GC lock before writing a renewal, including tenant-scoped renewal", async () => {
    await login(A);
    store.trace.length = 0;
    expect(await as(A, () => renewPushSession(A, A.pushSessionId!, store.expiry(120_000)))).toBe(true);
    // The fake store does not model PostgreSQL MVCC. This assertion protects
    // the required serialization boundary before an uncommitted expiry write.
    expect(store.trace.map(t => t.sql)).toEqual([SQL.advisory, SQL.renew]);
  });

  it("cannot extend expired authority while waiting behind a fresh login/GC transaction", async () => {
    await login(A, store.expiry(10)); await login(B); await register(B); await retire(B);
    const oldExpiry = store.sessions.get(A.pushSessionId!)!.expiresAt;
    const fresh: PushActor = { userId: "user-C", tenantId: "tenant-C", pushSessionId: "login-C" };
    store.addUser(fresh);
    const gate = store.holdNext(SQL.advisory);
    const creating = auth(() => createPushSession(fresh, fresh.pushSessionId!, store.expiry(120_000)));
    await gate.entered;
    const blocked = store.blockedOn("authority-order");
    const renewal = auth(() => renewPushSession(A, A.pushSessionId!, store.expiry(120_000)));
    await blocked;
    const expiryBeforeLock = store.sessions.get(A.pushSessionId!)!.expiresAt;
    store.now = oldExpiry;
    gate.release();
    await creating;
    const renewed = await renewal;
    expect(expiryBeforeLock).toBe(oldExpiry);
    expect(renewed).toBe(false);
    await changed(register(A));
    expect(store.fences.has(tokenDigest(token))).toBe(false);
  });

  it("fails closed for missing tenant context and pre-upgrade push actors", async () => {
    await login(A);
    await expect(registerPushDevice(A, input())).rejects.toThrow("declare tenant/system context");
    await expect(register({ userId: A.userId, tenantId: A.tenantId })).rejects.toMatchObject({ statusCode: 428 });
    const count = store.trace.length;
    await as(A, () => retirePushSession({ userId: A.userId, tenantId: A.tenantId }));
    expect(store.trace).toHaveLength(count);
    expect(store.devices.size).toBe(0);
  });
});
