/** Actual Express handlers with synthetic auth and ownership helpers. No listener or DB. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ notificationPref: { findUnique: vi.fn(), upsert: vi.fn() } }));
const auth = vi.hoisted(() => vi.fn());
const ownership = vi.hoisted(() => ({ register: vi.fn(), locale: vi.fn(), unregisterLegacy: vi.fn() }));
const cleanup = vi.hoisted(() => vi.fn());
vi.mock("../../lib/db", () => ({ prisma: db }));
vi.mock("../../middleware/auth", () => ({ authMiddleware: auth }));
vi.mock("../../lib/pushCleanup", () => ({ cleanupPushSession: cleanup }));
vi.mock("../../lib/pushOwnership", () => ({
  registerPushDevice: ownership.register,
  updatePushDeviceLocale: ownership.locale,
  unregisterLegacyPushDevice: ownership.unregisterLegacy,
  pushUpgradeRequired: () => Object.assign(new Error("Update the app and sign in to enable push notifications"), { statusCode: 428 }),
}));
import { deviceRouter } from "./router";

const actor = { userId: "owner-A", tenantId: "tenant-A", pushSessionId: "server-issued-session-A" };
const registration = { token: "synthetic-token", platform: "ios", revision: 7 };
const route = (method: string, path: string) => (deviceRouter as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);
async function invoke(method: string, path: string, body: unknown, authActor: typeof actor | { userId: string; tenantId: string } = actor, header = "en") {
  const req = { body, headers: { "accept-language": header }, auth: authActor };
  const json = vi.fn(); const next = vi.fn();
  await route(method, path).route.stack.at(-1).handle(req, { json }, next);
  return { req, json, next };
}

beforeEach(() => {
  vi.resetAllMocks();
  ownership.register.mockImplementation(async (_actor, input) => ({ success: true, revision: input.revision }));
  ownership.locale.mockResolvedValue(true);
  cleanup.mockResolvedValue(undefined);
  db.notificationPref.findUnique.mockResolvedValue(null);
});

describe("versioned per-device language routes", () => {
  it("keeps only the proof-based session cleanup route before generic authentication", async () => {
    const layers = (deviceRouter as any).stack;
    const authIndex = layers.findIndex((item: any) => item.handle === auth);
    expect(authIndex).toBe(1);
    expect(layers[0]).toBe(route("delete", "/push-session"));
    expect(layers.slice(authIndex + 1).filter((item: any) => item.route).map((item: any) => item.route.path)).toEqual([
      "/push-token", "/push-token/locale", "/push-token", "/notification-prefs", "/notification-prefs",
    ]);

    // Proof validation lives in cleanupPushSession; this route must not
    // substitute body identity when an expired access token has no req.auth.
    const req = { headers: { authorization: "Bearer synthetic-expired-access" }, body: { refreshToken: "synthetic-refresh-proof", pushSessionId: "forged-session", loginOrder: 999 } };
    const json = vi.fn(); const next = vi.fn();
    await layers[0].route.stack.at(-1).handle(req, { json }, next);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(req);
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(next).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(ownership.register).not.toHaveBeenCalled();
    expect(ownership.unregisterLegacy).not.toHaveBeenCalled();
  });

  it("forwards cleanup failures without acknowledging retirement", async () => {
    const error = new Error("synthetic cleanup failure");
    cleanup.mockRejectedValue(error);
    const { json, next } = await invoke("delete", "/push-session", { refreshToken: "synthetic-proof" });
    expect(next).toHaveBeenCalledExactlyOnceWith(error);
    expect(json).not.toHaveBeenCalled();
  });

  it("registers locale and revision under the authenticated server session", async () => {
    const incoming = { userId: "owner-B", tenantId: "tenant-B", pushSessionId: "server-issued-session-B" };
    const { json, next } = await invoke("post", "/push-token", { ...registration, locale: "ar", deviceName: "Synthetic phone", osVersion: "1.0" }, incoming, "tr");
    expect(next).not.toHaveBeenCalled();
    expect(ownership.register).toHaveBeenCalledExactlyOnceWith(incoming, { ...registration, locale: "ar", deviceName: "Synthetic phone", osVersion: "1.0" });
    expect(json).toHaveBeenCalledWith({ success: true, revision: 7 });
  });

  it("uses the selected app header and safe English fallback when explicit locale is absent", async () => {
    await invoke("post", "/push-token", registration, actor, "pt-PT");
    expect(ownership.register.mock.calls[0][1].locale).toBe("pt-BR");
    await invoke("post", "/push-token", registration, actor, "zh-Hant");
    expect(ownership.register.mock.calls[1][1].locale).toBe("en");
  });

  it("ignores body SID, account identity and login order rather than granting caller authority", async () => {
    const forged = { pushSessionId: "forged-session", sessionId: "forged-session", userId: "foreign-owner", tenantId: "foreign-tenant", loginOrder: 999999, order: 999999 };
    await invoke("post", "/push-token", { ...registration, locale: "tr", ...forged });
    expect(ownership.register).toHaveBeenCalledExactlyOnceWith(actor, { ...registration, locale: "tr" });
    await invoke("patch", "/push-token/locale", { token: registration.token, locale: "ja", revision: 7, ...forged });
    expect(ownership.locale).toHaveBeenCalledExactlyOnceWith(actor, registration.token, 7, "ja");
  });

  it.each([
    ["post", "/push-token", registration],
    ["patch", "/push-token/locale", { token: registration.token, locale: "tr", revision: 7 }],
  ])("returns 428 to legacy auth on %s %s even when the body forges a SID", async (method, path, body) => {
    const { json, next } = await invoke(method as string, path as string, { ...(body as object), pushSessionId: "forged-session", loginOrder: 99 }, { userId: "owner-A", tenantId: "tenant-A" });
    expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ statusCode: 428 }));
    expect(json).not.toHaveBeenCalled();
    expect(ownership.register).not.toHaveBeenCalled();
    expect(ownership.locale).not.toHaveBeenCalled();
  });

  it.each([undefined, null])("requires revision %s before registration and locale mutation", async revision => {
    for (const [method, path, body] of [
      ["post", "/push-token", registration],
      ["patch", "/push-token/locale", { token: registration.token, locale: "tr" }],
    ] as const) {
      const { json, next } = await invoke(method, path, { ...body, revision });
      expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ statusCode: 428 }));
      expect(json).not.toHaveBeenCalled();
    }
    expect(ownership.register).not.toHaveBeenCalled();
    expect(ownership.locale).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, "7", true, 2147483648])("rejects invalid revision %s without coercion or helper mutations", async revision => {
    for (const [method, path, body] of [
      ["post", "/push-token", registration],
      ["patch", "/push-token/locale", { token: registration.token, locale: "tr" }],
    ] as const) {
      const { json, next } = await invoke(method, path, { ...body, revision });
      expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "ZodError" }));
      expect(json).not.toHaveBeenCalled();
    }
    expect(ownership.register).not.toHaveBeenCalled();
    expect(ownership.locale).not.toHaveBeenCalled();
  });

  it.each([1, 2147483647])("accepts revision boundary %s", async revision => {
    const { next } = await invoke("post", "/push-token", { ...registration, revision });
    expect(next).not.toHaveBeenCalled();
    expect(ownership.register).toHaveBeenCalledWith(actor, { ...registration, revision, locale: "en" });
  });

  it.each([true, false])("reports locale helper result %s without re-registering a device", async success => {
    ownership.locale.mockResolvedValue(success);
    const { json, next } = await invoke("patch", "/push-token/locale", { token: registration.token, locale: "ja", revision: 7 });
    expect(next).not.toHaveBeenCalled();
    expect(ownership.locale).toHaveBeenCalledExactlyOnceWith(actor, registration.token, 7, "ja");
    expect(json).toHaveBeenCalledWith({ success });
    expect(ownership.register).not.toHaveBeenCalled();
  });

  it("keeps legacy token cleanup delegated to its guarded helper with a uniform response", async () => {
    const legacyActor = { userId: "retired-owner-A", tenantId: "tenant-A" };
    const { json, next } = await invoke("delete", "/push-token", { token: registration.token, pushSessionId: "forged-session", revision: 99 }, legacyActor);
    expect(next).not.toHaveBeenCalled();
    expect(ownership.unregisterLegacy).toHaveBeenCalledExactlyOnceWith(legacyActor, registration.token);
    expect(json).toHaveBeenCalledWith({ success: true });
  });

  it.each(["zh-Hant", "en-Cyrl", "ar-SA", "<script>"])("rejects noncanonical explicit locale %s before helper mutation", async locale => {
    for (const [method, path, body] of [
      ["post", "/push-token", registration],
      ["patch", "/push-token/locale", { token: registration.token }],
    ] as const) {
      const { next } = await invoke(method, path, { ...body, locale, revision: 7 });
      expect(next).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "ZodError" }));
    }
    expect(ownership.register).not.toHaveBeenCalled();
    expect(ownership.locale).not.toHaveBeenCalled();
  });
});

describe("legacy-compatible notification preferences", () => {
  const legacyActor = { userId: "legacy-owner", tenantId: "tenant-A" };
  it("still returns defaults without requiring push SID or revision", async () => {
    const { json, next } = await invoke("get", "/notification-prefs", undefined, legacyActor);
    expect(next).not.toHaveBeenCalled();
    expect(db.notificationPref.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { userId: "legacy-owner" } });
    expect(json).toHaveBeenCalledWith({ approvals: true, risks: true, runs: false, drafts: false });
  });

  it("returns existing preferences and saves only supported flags under authenticated user ownership", async () => {
    const prefs = { approvals: false, risks: true, runs: true, drafts: false };
    db.notificationPref.findUnique.mockResolvedValue(prefs);
    const read = await invoke("get", "/notification-prefs", undefined, legacyActor);
    expect(read.json).toHaveBeenCalledWith(prefs);
    db.notificationPref.upsert.mockResolvedValue({ ...prefs, drafts: true });
    const patch = await invoke("patch", "/notification-prefs", { drafts: true, userId: "foreign-owner", pushSessionId: "forged-session" }, legacyActor);
    expect(patch.next).not.toHaveBeenCalled();
    expect(db.notificationPref.upsert).toHaveBeenCalledExactlyOnceWith({ where: { userId: "legacy-owner" }, create: { userId: "legacy-owner", drafts: true }, update: { drafts: true } });
    expect(patch.json).toHaveBeenCalledWith({ success: true, ...prefs, drafts: true });
    expect(ownership.register).not.toHaveBeenCalled();
  });
});
