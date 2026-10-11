/** Real auth service + JWT/crypto; in-memory DB/Redis and provider/email adapters.
 * No live provider request, email delivery or production database is involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const envMock = vi.hoisted(() => ({
  JWT_SECRET: "service-test-secret-at-least-32-characters",
  JWT_EXPIRES_IN: "1h",
  JWT_REFRESH_EXPIRES_IN: "7d",
  GOOGLE_CLIENT_ID: "test-web-client",
  GOOGLE_CLIENT_SECRET: "synthetic-test-secret",
  GOOGLE_REDIRECT_URI: "https://example.invalid/auth/google/callback",
  GOOGLE_IOS_CLIENT_ID: "test-ios-client",
  APPLE_SIWA_BUNDLE_ID: "test.apple.mobile",
  APPLE_WEB_SERVICE_ID: "test.apple.web",
  GITHUB_CLIENT_ID: "test-github-web",
  GITHUB_CLIENT_SECRET: "synthetic-github-secret",
  GITHUB_REDIRECT_URI: "https://example.invalid/auth/github/callback",
  GITHUB_MOBILE_CLIENT_ID: "test-github-mobile",
  GITHUB_MOBILE_CLIENT_SECRET: "synthetic-github-mobile-secret",
}));
const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  tenant: { create: vi.fn() },
  activityLog: { create: vi.fn() },
}));
const redisMock = vi.hoisted(() => ({
  get: vi.fn(), del: vi.fn(), set: vi.fn(), call: vi.fn(), scan: vi.fn(), pipeline: vi.fn(),
}));
const hashMock = vi.hoisted(() => vi.fn());
const googleVerify = vi.hoisted(() => vi.fn());
const googleGetToken = vi.hoisted(() => vi.fn());
const googleConstructor = vi.hoisted(() => vi.fn());
const appleVerify = vi.hoisted(() => vi.fn());
const providerFetch = vi.hoisted(() => vi.fn());
vi.mock("../../../config/env", () => ({ env: envMock }));
vi.mock("../../../lib/db", () => ({ prisma: db, tenantTx: (fn: (tx: typeof db) => unknown) => fn(db) }));
vi.mock("../../../lib/redis", () => ({ redis: redisMock }));
vi.mock("../../../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../../integrations/email-templates", () => ({
  sendWelcomeEmail: vi.fn(), sendPasswordResetEmail: vi.fn(), sendVerifyEmail: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ default: {
  hashSync: () => "dummy-test-hash",
  hash: (...args: unknown[]) => hashMock(...args),
  compare: vi.fn(),
} }));
vi.mock("google-auth-library", () => ({ OAuth2Client: class {
  constructor(...args: unknown[]) { googleConstructor(...args); }
  getToken(...args: unknown[]) { return googleGetToken(...args); }
  verifyIdToken(...args: unknown[]) { return googleVerify(...args); }
} }));
vi.mock("jose", () => ({
  createRemoteJWKSet: () => "synthetic-apple-jwks",
  jwtVerify: (...args: unknown[]) => appleVerify(...args),
}));

import {
  appleMobileSignIn, appleWebCallback, githubCallback, githubMobileSignIn,
  googleCallback, googleMobileSignIn, googleMobileCodeSignIn, refreshTokens, resetPassword, redeemOAuthExchange,
} from "../auth.service";

type UserRow = {
  id: string; tenantId: string; email: string; name: string;
  role: string; googleId: string | null; appleId: string | null; githubId: string | null;
  emailVerifiedAt: Date | null;
  avatarUrl: string | null; passwordHash: string;
  resetTokenHash: string | null; resetTokenExpiresAt: Date | null;
  tenant: { id: string; name: string; slug: string; plan: string };
};
const resetToken = "synthetic-reset-token";
const resetHash = crypto.createHash("sha256").update(resetToken).digest("hex");
let users: UserRow[];
let keys: Map<string, string>;

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-a", tenantId: "tenant-a", email: "owner@gmail.com", name: "Owner",
    role: "OWNER", googleId: null, appleId: null, githubId: null,
    emailVerifiedAt: null, avatarUrl: null,
    passwordHash: "old-password-hash", resetTokenHash: resetHash,
    resetTokenExpiresAt: new Date(Date.now() + 60_000),
    tenant: { id: "tenant-a", name: "Tenant", slug: "tenant", plan: "INDIVIDUAL" },
    ...overrides,
  };
}

function matches(user: UserRow, where: Record<string, any>): boolean {
  if (where.OR && !where.OR.some((candidate: Record<string, any>) => matches(user, candidate))) return false;
  for (const [field, expected] of Object.entries(where)) {
    if (field === "OR") continue;
    const actual = (user as any)[field];
    if (expected && typeof expected === "object" && "gt" in expected) {
      if (!(actual instanceof Date) || actual <= expected.gt) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}

function refreshTokenFor(user = users[0]) {
  const jti = "original-session";
  keys.set(`refresh:${user.id}:${jti}`, "1");
  return jwt.sign({ userId: user.id, tenantId: user.tenantId, role: "OWNER", typ: "refresh", jti },
    envMock.JWT_SECRET, { algorithm: "HS256", expiresIn: "7d" });
}

const mobileNonce = "a".repeat(64);
function googleProfile(profile: Record<string, unknown>) {
  googleVerify.mockResolvedValue({ getPayload: () => ({ nonce: mobileNonce, exp: Math.floor(Date.now()/1000)+3600, ...profile }) });
}

function appleProfile(profile: Record<string, unknown>) {
  appleVerify.mockResolvedValue({ payload: { nonce: mobileNonce, exp: Math.floor(Date.now()/1000)+3600, ...profile } });
}

function githubProfile(
  profile: Record<string, unknown>,
  emails: Array<{ email: string; primary: boolean; verified: boolean }> = [
    { email: "owner@gmail.com", primary: true, verified: true },
  ],
  emailsStatus = 200,
) {
  providerFetch.mockImplementation(async (url: string) => {
    const data = url === "https://github.com/login/oauth/access_token"
      ? { access_token: "synthetic-github-access-token" }
      : url === "https://api.github.com/user"
        ? { id: 101, login: "test-user", name: "Test User", email: "owner@gmail.com", avatar_url: null, ...profile }
        : url === "https://api.github.com/user/emails" ? emails : undefined;
    if (data === undefined) throw new Error(`Unexpected mocked provider URL: ${url}`);
    return new Response(JSON.stringify(data), { status: url.endsWith("/emails") ? emailsStatus : 200 });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", providerFetch);
  providerFetch.mockImplementation(async () => { throw new Error("Unexpected provider request in auth test"); });
  users = [makeUser()];
  keys = new Map();
  hashMock.mockImplementation(async (password: string) => `test-hash:${password}`);
  db.user.findFirst.mockImplementation(async ({ where }) => {
    const user = users.find((u) => matches(u, where));
    return user ? { ...user } : null;
  });
  db.user.findUnique.mockImplementation(async ({ where }) => {
    const user = users.find((u) => matches(u, where));
    return user ? { ...user } : null;
  });
  db.user.update.mockImplementation(async ({ where, data }) => {
    const user = users.find((u) => matches(u, where));
    if (!user) throw new Error("No matching test user");
    Object.assign(user, data);
    return { ...user };
  });
  db.user.updateMany.mockImplementation(async ({ where, data }) => {
    const selected = users.filter((u) => matches(u, where));
    selected.forEach((u) => Object.assign(u, data));
    return { count: selected.length };
  });
  db.user.create.mockImplementation(async ({ data }) => {
    const user = makeUser({ ...data, id: "new-user", tenant: {
      id: data.tenantId, name: "New Tenant", slug: "new-tenant", plan: "FREE",
    } });
    users.push(user);
    return { ...user };
  });
  db.tenant.create.mockResolvedValue({ id: "new-tenant", name: "New Tenant", slug: "new-tenant", plan: "FREE" });
  db.activityLog.create.mockResolvedValue({ id: "audit" });
  redisMock.get.mockImplementation(async (key: string) => keys.get(key) ?? null);
  redisMock.del.mockImplementation(async (key: string) => Number(keys.delete(key)));
  redisMock.set.mockImplementation(async (key: string, value: string) => { keys.set(key, value); return "OK"; });
  redisMock.call.mockImplementation(async (command: string, key: string) => {
    if (command === "SET") { if(keys.has(key)) return null; keys.set(key,"1"); return "OK"; }
    if (command !== "GETDEL") throw new Error("Only GETDEL is supported by the test Redis");
    const value = keys.get(key) ?? null;
    keys.delete(key);
    return value;
  });
  redisMock.scan.mockImplementation(async (_cursor, _match, pattern: string) => ["0", [...keys.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)))]);
  redisMock.pipeline.mockImplementation(() => {
    const pending: string[] = [];
    const pipeline = {
      del(key: string) { pending.push(key); return pipeline; },
      async exec() { pending.forEach((key) => keys.delete(key)); return []; },
    };
    return pipeline;
  });
  googleGetToken.mockResolvedValue({ tokens: { id_token: "synthetic-google-token" } });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("refresh token consumption", () => {
  it("allows exactly one of two concurrent redemptions of the same refresh JWT", async () => {
    const token = refreshTokenFor();
    const outcomes = await Promise.allSettled([refreshTokens(token), refreshTokens(token)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 401 });
  });

  it("returns fresh DB role and tenant, then rejects sequential replay", async () => {
    const token = refreshTokenFor();
    users[0].role = "MEMBER";
    users[0].tenantId = "tenant-new";
    users[0].tenant.id = "tenant-new";
    const refreshed = await refreshTokens(token);
    expect(jwt.verify(refreshed.token, envMock.JWT_SECRET)).toMatchObject({ role: "MEMBER", tenantId: "tenant-new" });
    expect(refreshed.tenant.id).toBe("tenant-new");
    await expect(refreshTokens(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("fails closed when Redis is unavailable", async () => {
    const token = refreshTokenFor();
    redisMock.call.mockRejectedValueOnce(new Error("unavailable"));
    redisMock.get.mockRejectedValueOnce(new Error("unavailable"));
    await expect(refreshTokens(token)).rejects.toMatchObject({ statusCode: 503 });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not fall back to non-atomic GET+DEL when GETDEL is unsupported", async () => {
    const token = refreshTokenFor();
    redisMock.call.mockRejectedValueOnce(new Error("unknown command GETDEL"));
    await expect(refreshTokens(token)).rejects.toMatchObject({ statusCode: 503 });
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it("fails closed if Redis cannot persist the replacement refresh session", async () => {
    const token = refreshTokenFor();
    redisMock.set.mockRejectedValueOnce(new Error("unavailable"));
    await expect(refreshTokens(token)).rejects.toMatchObject({ statusCode: 503 });
    await expect(refreshTokens(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a deleted refresh owner without minting another session", async () => {
    const token = refreshTokenFor();
    users = [];
    await expect(refreshTokens(token)).rejects.toMatchObject({ statusCode: 401 });
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

describe("password reset single-use boundary", () => {
  it("allows exactly one concurrent reset and does not overwrite its winning password", async () => {
    const outcomes = await Promise.allSettled([
      resetPassword(resetToken, "FirstPassword1"),
      resetPassword(resetToken, "SecondPassword2"),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 400 });
    expect(users[0].passwordHash).toBe("test-hash:FirstPassword1");
    expect(users[0].resetTokenHash).toBeNull();
    expect(db.activityLog.create).toHaveBeenCalledOnce();
  });

  it("rejects expiry during password hashing without changing the password", async () => {
    hashMock.mockImplementationOnce(async () => {
      users[0].resetTokenExpiresAt = new Date(0);
      return "late-password-hash";
    });
    await expect(resetPassword(resetToken, "NewPassword1")).rejects.toMatchObject({ statusCode: 400 });
    expect(users[0].passwordHash).toBe("old-password-hash");
  });

  it("rejects a link superseded during hashing and preserves the newer token", async () => {
    hashMock.mockImplementationOnce(async () => {
      users[0].resetTokenHash = "new-reset-hash";
      return "stale-password-hash";
    });
    await expect(resetPassword(resetToken, "NewPassword1")).rejects.toMatchObject({ statusCode: 400 });
    expect(users[0].resetTokenHash).toBe("new-reset-hash");
    expect(users[0].passwordHash).toBe("old-password-hash");
  });

  it("preserves a normal reset and rejects expired, invalid and replayed links", async () => {
    await expect(resetPassword("unknown-reset-token", "NewPassword1")).rejects.toMatchObject({ statusCode: 400 });
    users[0].resetTokenExpiresAt = new Date(0);
    await expect(resetPassword(resetToken, "NewPassword1")).rejects.toMatchObject({ statusCode: 400 });
    users[0].resetTokenExpiresAt = new Date(Date.now() + 60_000);
    await resetPassword(resetToken, "NewPassword1");
    expect(users[0].passwordHash).toBe("test-hash:NewPassword1");
    await expect(resetPassword(resetToken, "AnotherPassword2")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe.each([
  ["web", () => googleCallback("synthetic-code")],
  ["mobile", () => googleMobileSignIn("header.google-payload.signature", mobileNonce)],
] as const)("Google %s identity ownership", (_surface, signIn) => {
  it("prefers the exact provider subject even when its email now matches another account", async () => {
    const own = makeUser({ id: "subject-owner", googleId: "google-own", email: "old@example.test" });
    users = [makeUser({ id: "email-victim" }), own];
    googleProfile({ sub: "google-own", email: "owner@gmail.com", email_verified: true });
    const result = await signIn();
    expect(result.user.id).toBe("subject-owner");
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("keeps an existing provider subject usable without relying on email ownership claims", async () => {
    users[0].googleId = "google-own";
    googleProfile({ sub: "google-own" });
    expect((await signIn()).user.id).toBe("user-a");
  });

  it("rejects an unverified email fallback without linking or issuing tokens", async () => {
    googleProfile({ sub: "google-new", email: "owner@gmail.com", email_verified: false });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("does not auto-link a verified third-party email whose current owner Google cannot vouch for", async () => {
    users[0].email = "owner@third-party.test";
    googleProfile({ sub: "google-new", email: users[0].email, email_verified: true });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("does not treat an existing account's earlier mailbox verification as a Google linking challenge", async () => {
    users[0].email = "owner@third-party.test";
    users[0].emailVerifiedAt = new Date();
    googleProfile({ sub: "google-new", email: users[0].email, email_verified: true });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("rejects a different existing Google subject even for the same verified Gmail email", async () => {
    users[0].googleId = "google-existing";
    googleProfile({ sub: "google-different", email: "owner@gmail.com", email_verified: true });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("links a verified Gmail account and canonicalizes its email", async () => {
    googleProfile({ sub: "google-new", email: "OWNER@GMAIL.COM", email_verified: true });
    const result = await signIn();
    expect(result.user.id).toBe("user-a");
    expect(users[0].googleId).toBe("google-new");
  });

  it("does not overwrite a Google subject linked after the email lookup", async () => {
    googleProfile({ sub: "google-new", email: "owner@gmail.com", email_verified: true });
    db.user.updateMany.mockImplementationOnce(async () => {
      users[0].googleId = "google-other";
      return { count: 0 };
    });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(users[0].googleId).toBe("google-other");
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("links a verified Workspace email only when its hosted domain matches", async () => {
    users[0].email = "owner@workspace.test";
    googleProfile({ sub: "google-new", email: users[0].email, email_verified: true, hd: "workspace.test" });
    expect((await signIn()).user.id).toBe("user-a");
    expect(users[0].googleId).toBe("google-new");
  });

  it("rejects an unrelated hosted-domain claim", async () => {
    users[0].email = "owner@third-party.test";
    googleProfile({ sub: "google-new", email: users[0].email, email_verified: true, hd: "different.test" });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("preserves new third-party Google signup without auto-verifying mailbox ownership", async () => {
    users = [];
    googleProfile({ sub: "google-new", email: "new@third-party.test", email_verified: true });
    const result = await signIn();
    expect(result.user.email).toBe("new@third-party.test");
    expect(users[0].googleId).toBe("google-new");
    expect(users[0].emailVerifiedAt).toBeNull();
  });

  it("rejects a new Google identity with an unverified mailbox", async () => {
    users = [];
    googleProfile({ sub: "google-new", email: "new@gmail.com", email_verified: false });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(db.user.create).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

describe.each([
  { surface: "Apple web", provider: "apple", field: "appleId", subject: "apple-own",
    signIn: () => appleWebCallback("synthetic-apple-token", null),
    profile: (email?: string) => appleProfile({ sub: "apple-own", email, email_verified: true }) },
  { surface: "Apple mobile", provider: "apple", field: "appleId", subject: "apple-own",
    signIn: () => appleMobileSignIn("header.apple-payload.signature", null, mobileNonce),
    profile: (email?: string) => appleProfile({ sub: "apple-own", email, email_verified: true }) },
  { surface: "GitHub web", provider: "github", field: "githubId", subject: "101",
    signIn: () => githubCallback("synthetic-github-code"),
    profile: (email?: string) => githubProfile({ email: email ?? null }, email ? [{ email, primary: true, verified: true }] : [], 503) },
  { surface: "GitHub mobile", provider: "github", field: "githubId", subject: "101",
    signIn: () => githubMobileSignIn("synthetic-github-code", "braavolabs://oauth/github/callback"),
    profile: (email?: string) => githubProfile({ email: email ?? null }, email ? [{ email, primary: true, verified: true }] : [], 503) },
])("$surface stable identity ownership", ({ provider, field, subject, signIn, profile }) => {
  it("selects the subject owner ahead of another account matching the token/profile email", async () => {
    users = [makeUser({ id: "email-victim" }), makeUser({
      id: "subject-owner", email: "old@example.test", [field]: subject,
    })];
    profile("owner@gmail.com");
    const result = await signIn();
    expect(result.user.id).toBe("subject-owner");
    expect(jwt.verify(result.token, envMock.JWT_SECRET)).toMatchObject({ userId: "subject-owner" });
    expect((users[0] as any)[field]).toBeNull();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it("allows the exact subject without email evidence and does not verify a different mailbox", async () => {
    (users[0] as any)[field] = subject;
    profile();
    expect((await signIn()).user.id).toBe("user-a");
    expect(users[0].emailVerifiedAt).toBeNull();
    expect(providerFetch.mock.calls.filter(([url]) => url.endsWith("/emails"))).toHaveLength(0);
  });

  it("rejects a conflicting existing subject even with a verified matching email", async () => {
    (users[0] as any)[field] = `${provider}-different`;
    if (provider === "apple") appleProfile({ sub: subject, email: "owner@gmail.com", email_verified: true });
    else githubProfile({});
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect((users[0] as any)[field]).toBe(`${provider}-different`);
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("conditionally links a verified address with matching canonical email", async () => {
    if (provider === "apple") appleProfile({ sub: subject, email: "OWNER@GMAIL.COM", email_verified: true });
    else githubProfile({ email: "OWNER@GMAIL.COM" }, [{ email: "OWNER@GMAIL.COM", primary: true, verified: true }]);
    const result = await signIn();
    expect(result.user.id).toBe("user-a");
    expect((users[0] as any)[field]).toBe(subject);
    expect(users[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(db.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-a", email: "owner@gmail.com", [field]: null },
    }));
  });

  it("rejects a link lost to a concurrent subject change without overwriting its winner", async () => {
    if (provider === "apple") appleProfile({ sub: subject, email: "owner@gmail.com", email_verified: true });
    else githubProfile({});
    const lookupWithRace = async ({ where }: { where: Record<string, unknown> }) => {
      const row = users.find((u) => matches(u, where));
      const snapshot = row ? { ...row } : null;
      if (snapshot && (where.email || where.OR)) (row as any)[field] = `${provider}-winner`;
      return snapshot;
    };
    db.user.findFirst.mockImplementation(lookupWithRace);
    db.user.findUnique.mockImplementation(lookupWithRace);
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect((users[0] as any)[field]).toBe(`${provider}-winner`);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("allows only one concurrent claim of an unlinked address", async () => {
    if (provider === "apple") appleProfile({ sub: subject, email: "owner@gmail.com", email_verified: true });
    else githubProfile({});
    const outcomes = await Promise.allSettled([signIn(), signIn()]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 401 });
    expect((users[0] as any)[field]).toBe(subject);
    expect(redisMock.set).toHaveBeenCalledOnce();
  });
});

describe.each([
  ["web", () => appleWebCallback("synthetic-apple-token", null), envMock.APPLE_WEB_SERVICE_ID],
  ["mobile", () => appleMobileSignIn("header.apple-payload.signature", null, mobileNonce), envMock.APPLE_SIWA_BUNDLE_ID],
] as const)("Apple %s email proof", (_surface, signIn, audience) => {
  it.each([false, "false", undefined])("rejects unknown subjects with email_verified=%s", async (email_verified) => {
    appleProfile({ sub: "apple-new", email: "owner@gmail.com", email_verified });
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it.each([true, "true"])("permits verified new identities with email_verified=%s", async (email_verified) => {
    users = [];
    appleProfile({ sub: "apple-new", email: "new@privaterelay.appleid.com", email_verified });
    const result = await signIn();
    expect(result.user.email).toBe("new@privaterelay.appleid.com");
    expect(users[0].appleId).toBe("apple-new");
    expect(users[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(appleVerify).toHaveBeenCalledWith(_surface === "mobile" ? "header.apple-payload.signature" : "synthetic-apple-token", "synthetic-apple-jwks", {
      issuer: "https://appleid.apple.com", audience,
    });
  });

  it("rejects verifier failure before account lookup or writes", async () => {
    appleVerify.mockRejectedValueOnce(new Error("wrong audience"));
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

it("does not treat the unsigned Apple web user.email form field as verified identity", async () => {
  appleProfile({ sub: "apple-new", email_verified: true });
  await expect(appleWebCallback("synthetic-apple-token", JSON.stringify({
    email: "owner@gmail.com", name: { firstName: "Test", lastName: "User" },
  }))).rejects.toMatchObject({ statusCode: 401 });
  expect(users[0].appleId).toBeNull();
  expect(redisMock.set).not.toHaveBeenCalled();
});

describe.each([
  ["web", () => githubCallback("synthetic-github-code")],
  ["mobile", () => githubMobileSignIn("synthetic-github-code", "braavolabs://oauth/github/callback")],
] as const)("GitHub %s verified email proof", (_surface, signIn) => {
  it("requires verified /user/emails evidence even when the public profile includes an email", async () => {
    githubProfile({}, [{ email: "owner@gmail.com", primary: true, verified: false }]);
    await expect(signIn()).rejects.toMatchObject({ statusCode: 401 });
    expect(users[0].githubId).toBeNull();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledWith("https://api.github.com/user/emails", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer synthetic-github-access-token" }),
    }));
  });

  it("uses the authenticated verified address ahead of an unproven public email", async () => {
    githubProfile({}, [{ email: "own@example.test", primary: true, verified: true }]);
    const result = await signIn();
    expect(result.user.email).toBe("own@example.test");
    expect(result.user.id).toBe("new-user");
    expect(users[0].githubId).toBeNull();
    expect(users[1].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("preserves a verified private secondary address when no verified primary is available", async () => {
    githubProfile({ email: null }, [
      { email: "unverified@example.test", primary: true, verified: false },
      { email: "owner@gmail.com", primary: false, verified: true },
    ]);
    expect((await signIn()).user.id).toBe("user-a");
    expect(users[0].githubId).toBe("101");
  });

  it("fails closed on unavailable email evidence instead of using the public profile", async () => {
    githubProfile({}, [], 503);
    await expect(signIn()).rejects.toMatchObject({ statusCode: 503 });
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

 describe.each(["google", "apple"] as const)("mobile %s nonce and replay", (provider) => {
  const signIn = (nonce?: string) => provider === "google" ? googleMobileSignIn("header.signed-payload.signature", nonce) : appleMobileSignIn("header.signed-payload.signature", null, nonce);
  beforeEach(() => { users[0].googleId = "subject"; users[0].appleId = "subject"; googleProfile({sub:"subject"}); appleProfile({sub:"subject"}); });
  it("rejects missing nonce before account mutation", async () => { await expect(signIn()).rejects.toMatchObject({statusCode:401}); expect(db.user.create).not.toHaveBeenCalled(); expect(redisMock.call).not.toHaveBeenCalled(); expect(db.user.findFirst).not.toHaveBeenCalled(); });
  it("rejects mismatched nonce", async () => { await expect(signIn("b".repeat(64))).rejects.toMatchObject({statusCode:401}); expect(redisMock.call).not.toHaveBeenCalled(); expect(db.user.findFirst).not.toHaveBeenCalled(); });
  it("rejects signed token without nonce", async () => { googleProfile({sub:"subject",nonce:undefined}); appleProfile({sub:"subject",nonce:undefined}); await expect(signIn(mobileNonce)).rejects.toMatchObject({statusCode:401}); });
  it("rejects expired token", async () => { googleProfile({sub:"subject",exp:1}); appleProfile({sub:"subject",exp:1}); await expect(signIn(mobileNonce)).rejects.toMatchObject({statusCode:401}); });
  it("rejects missing or non-finite expiry", async () => { googleProfile({sub:"subject",exp:NaN}); appleProfile({sub:"subject",exp:undefined}); await expect(signIn(mobileNonce)).rejects.toMatchObject({statusCode:401}); expect(redisMock.call).not.toHaveBeenCalled(); });
  it("issues one session and refuses replay", async () => { await expect(signIn(mobileNonce)).resolves.toMatchObject({user:{id:"user-a"}}); await expect(signIn(mobileNonce)).rejects.toMatchObject({statusCode:401}); expect(redisMock.set).toHaveBeenCalledOnce(); });
  it("fails closed when replay store is unavailable", async () => { redisMock.call.mockRejectedValueOnce(new Error("offline")); await expect(signIn(mobileNonce)).rejects.toMatchObject({statusCode:503}); expect(redisMock.set).not.toHaveBeenCalled(); });
 });

it.skipIf(!process.env.LOCAL_REDIS_TEST_URL)("consumes concurrent verified mobile token atomically in private real Redis", async () => {
  const { default: Redis } = await import("ioredis");
  const client = new Redis(process.env.LOCAL_REDIS_TEST_URL!, {maxRetriesPerRequest:1});
  try {
    const actual = await vi.importActual<typeof import("jose")>("jose");
    const signingKey = new TextEncoder().encode("fixture-google-signing-key-32-characters");
    const issue = () => new actual.SignJWT({nonce:mobileNonce}).setProtectedHeader({alg:"HS256"}).setSubject("subject").setIssuer("https://accounts.google.com").setAudience(envMock.GOOGLE_CLIENT_ID).setJti(crypto.randomUUID()).setExpirationTime("1h").sign(signingKey);
    const token = await issue();
    users[0].googleId = "subject";
    googleVerify.mockImplementation(async ({idToken,audience}) => {
      const result=await actual.jwtVerify(idToken,signingKey,{issuer:"https://accounts.google.com",audience});
      return {getPayload:()=>result.payload};
    });
    redisMock.call.mockImplementation((...args: any[]) => (client.call as any)(...args));
    const results = await Promise.allSettled([googleMobileSignIn(token, mobileNonce), googleMobileSignIn(token+"=", mobileNonce)]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(x => x.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({statusCode:401});
    expect(redisMock.set).toHaveBeenCalledOnce();
    await expect(googleMobileSignIn(await issue(), mobileNonce)).resolves.toMatchObject({user:{id:"user-a"}});
  } finally { client.disconnect(); }
});

describe("native Google mobile authorization code exchange", () => {
 beforeEach(() => { users[0].googleId = "subject"; googleProfile({sub:"subject"}); });
 it("exchanges native code without browser redirect and pins web-client audience", async () => {
  await expect(googleMobileCodeSignIn("native-code")).resolves.toMatchObject({user:{id:"user-a"}});
  expect(googleGetToken).toHaveBeenCalledWith({code:"native-code",redirect_uri:""});
  expect(googleVerify).toHaveBeenCalledWith({idToken:"synthetic-google-token",audience:envMock.GOOGLE_CLIENT_ID});
 });
 it("requires server client configuration before exchange", async () => {
  const original=envMock.GOOGLE_CLIENT_SECRET; envMock.GOOGLE_CLIENT_SECRET="";
  try { await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:503}); expect(googleGetToken).not.toHaveBeenCalled(); }
  finally {envMock.GOOGLE_CLIENT_SECRET=original;}
 });
 it("refuses missing returned identity token", async () => {googleGetToken.mockResolvedValueOnce({tokens:{}});await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:401});expect(db.user.findFirst).not.toHaveBeenCalled();});
 it("refuses invalid signature or audience without exposing provider details", async () => {googleVerify.mockRejectedValueOnce(new Error("synthetic-sensitive-token"));await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:401,message:"Google mobile authorization code verification failed"});expect(db.user.findFirst).not.toHaveBeenCalled();});
 it("refuses missing subject", async () => {googleProfile({sub:undefined});await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:401});expect(db.user.findFirst).not.toHaveBeenCalled();});
 it("propagates the provider's one-time code rejection on replay", async () => { googleGetToken.mockResolvedValueOnce({tokens:{id_token:"synthetic-google-token"}}).mockRejectedValueOnce(new Error("invalid_grant")); await expect(googleMobileCodeSignIn("native-code")).resolves.toMatchObject({user:{id:"user-a"}});await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:401});expect(redisMock.set).toHaveBeenCalledOnce();});
 it("does not issue a session on exchange failure", async () => {googleGetToken.mockRejectedValueOnce(new Error("provider unavailable"));await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:401});expect(redisMock.set).not.toHaveBeenCalled();});
 it("retains third-party mailbox collision protection", async () => {users[0].googleId=null;googleProfile({sub:"other",email:"owner@gmail.com",email_verified:false});await expect(googleMobileCodeSignIn("native-code")).rejects.toMatchObject({statusCode:401});expect(db.user.create).not.toHaveBeenCalled();});
});

it("uses one replay key for actual jose-verified signature padding aliases", async () => {
 const actual = await vi.importActual<typeof import("jose")>("jose");
 const key = new TextEncoder().encode("fixture-hmac-key-at-least-32-characters");
 const token = await new actual.SignJWT({nonce:mobileNonce}).setProtectedHeader({alg:"HS256"}).setSubject("subject").setIssuer("https://appleid.apple.com").setAudience(envMock.APPLE_SIWA_BUNDLE_ID).setExpirationTime("1h").sign(key);
 const alias = token+"=";
 await actual.jwtVerify(alias,key,{issuer:"https://appleid.apple.com",audience:envMock.APPLE_SIWA_BUNDLE_ID});
 appleVerify.mockImplementation(async (raw: string, _jwks:unknown, opts:any) => actual.jwtVerify(raw,key,opts));
 users[0].appleId="subject";
 await expect(appleMobileSignIn(token,null,mobileNonce)).resolves.toMatchObject({user:{id:"user-a"}});
 await expect(appleMobileSignIn(alias,null,mobileNonce)).rejects.toMatchObject({statusCode:401});
 expect(redisMock.set).toHaveBeenCalledOnce();
});
it("refuses malformed verified fixture tokens before consuming or account lookup", async () => {
 googleProfile({sub:"subject"});
 await expect(googleMobileSignIn("not-a-jws",mobileNonce)).rejects.toMatchObject({statusCode:401});
 expect(redisMock.call).not.toHaveBeenCalled();expect(db.user.findFirst).not.toHaveBeenCalled();
});

it("sends an explicit empty native redirect using actual installed Google library", async () => {
 users[0].googleId="subject";googleProfile({sub:"subject"});
 await googleMobileCodeSignIn("native-code");
 const options=googleConstructor.mock.calls[0][0];
 expect(options).toEqual({clientId:envMock.GOOGLE_CLIENT_ID,clientSecret:envMock.GOOGLE_CLIENT_SECRET,redirect_uris:[""]});
 const actual=await vi.importActual<typeof import("google-auth-library")>("google-auth-library");
 const client=new actual.OAuth2Client(options);
 const transport=vi.spyOn(client.transporter,"request").mockResolvedValue({data:{id_token:"fixture"},headers:new Headers()} as any);
 await client.getToken({code:"native-code",redirect_uri:""});
 const body=transport.mock.calls[0][0].data as URLSearchParams;
 expect(body.get("redirect_uri")).toBe("");expect(body.get("code")).toBe("native-code");
});


describe("OAuth exchange atomic consumption", () => {
  it("allows exactly one concurrent redemption", async () => {
    keys.set("oauth:exchange:synthetic-code", JSON.stringify({ token: "synthetic-bundle" }));
    const outcomes = await Promise.allSettled([
      redeemOAuthExchange("synthetic-code"), redeemOAuthExchange("synthetic-code"),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o => o.status === "rejected")).toHaveLength(1);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it.each(["unknown command GETDEL", "connection lost"])("fails closed on %s without non-atomic fallback", async error => {
    keys.set("oauth:exchange:synthetic-code", JSON.stringify({ token: "synthetic-bundle" }));
    redisMock.call.mockRejectedValueOnce(new Error(error));
    await expect(redeemOAuthExchange("synthetic-code")).rejects.toMatchObject({ statusCode: 503 });
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
    expect(keys.has("oauth:exchange:synthetic-code")).toBe(true);
  });
});
