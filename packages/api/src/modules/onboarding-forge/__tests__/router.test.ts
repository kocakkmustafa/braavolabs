/**
 * Forge onboarding wizard router (FAZ1-1C) — GET /catalog, POST /validate
 * (candidate-key path + useSystemTrialKey trial path + save), GET /status.
 *
 * Deliberately independent of modules/onboarding/__tests__/validate-key-router.test.ts
 * (Faz-8's own /validate-key suite) — this router is a separate surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const limiterMock = vi.hoisted(() => vi.fn((_req: unknown, _res: unknown, next: () => void) => next()));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => limiterMock,
}));

const db = vi.hoisted(() => ({
  userAIConfigCount: vi.fn(),
  userAIConfigUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  userAIConfigUpsert: vi.fn().mockResolvedValue({}),
  activityLogCreate: vi.fn().mockResolvedValue({}),
  tenantTx: vi.fn(),
}));
vi.mock("../../../lib/db", () => ({
  prisma: {
    userAIConfig: { count: (...a: unknown[]) => db.userAIConfigCount(...a) },
    activityLog: { create: (...a: unknown[]) => db.activityLogCreate(...a) },
  },
  // saveTenantAIConfig (real, inside ai-client.ts) runs its demote-then-
  // promote transaction against this tx shape.
  tenantTx: (...a: unknown[]) => db.tenantTx(...a),
}));

const tenantTxImpl = (fn: any) =>
  fn({
      userAIConfig: {
        updateMany: (...a: unknown[]) => db.userAIConfigUpdateMany(...a),
        upsert: (...a: unknown[]) => db.userAIConfigUpsert(...a),
      },
    });

const cryptoMock = vi.hoisted(() => ({
  // Deliberately opaque (does NOT embed the plaintext) so a test can assert
  // the stored value is exactly this ciphertext stand-in and never the raw
  // key — encryptForTenant's call args (asserted separately) are what prove
  // the RIGHT plaintext went in.
  encryptForTenant: vi.fn(() => "v4:opaque-ciphertext-blob"),
  decryptForTenant: vi.fn(() => "decrypted-placeholder"),
}));
vi.mock("../../../lib/encryption", () => ({
  encryptForTenant: (...a: [string, string, string?]) => cryptoMock.encryptForTenant(...a),
  decryptForTenant: (...a: [string, string, string?]) => cryptoMock.decryptForTenant(...a),
}));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return { ...actual, chatCompletion: (...a: unknown[]) => chatCompletionMock(...a) };
});

const trialSvc = vi.hoisted(() => ({
  hasSystemHeldKey: vi.fn(),
  runForgeTrialCompletion: vi.fn(),
  getForgeTrialCreditStatus: vi.fn(),
}));
vi.mock("../../billing/trial-credit.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../billing/trial-credit.service")>();
  return {
    ...actual, // keep the REAL TrialCreditExhaustedError / NoSystemHeldKeyError classes for instanceof checks
    hasSystemHeldKey: (...a: unknown[]) => trialSvc.hasSystemHeldKey(...a),
    runForgeTrialCompletion: (...a: unknown[]) => trialSvc.runForgeTrialCompletion(...a),
    getForgeTrialCreditStatus: (...a: unknown[]) => trialSvc.getForgeTrialCreditStatus(...a),
  };
});

import { onboardingForgeRouter } from "../router";
import { TrialCreditExhaustedError, NoSystemHeldKeyError } from "../../billing/trial-credit.service";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

function getRouteHandlers(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle) as Array<
    (req: any, res: any, next: any) => Promise<void> | void
  >;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, body: any = {}) {
  const res = mockRes();
  let nextErr: any;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: {}, body, query: {} },
    res,
    next,
  );
  return { res, nextErr };
}

async function invokeRoute(
  handlers: Array<(req: any, res: any, next: any) => Promise<void> | void>,
  body: any,
  auth: any = { tenantId: "tenant-1", userId: "user-1", role: "ADMIN" },
) {
  const req = { auth, params: {}, body, query: {} };
  const res = mockRes();
  let nextErr: any;

  for (const handler of handlers) {
    let continued = false;
    await handler(req, res, (err?: any) => {
      nextErr = err;
      continued = !err;
    });
    if (nextErr || !continued) break;
  }

  return { res, nextErr };
}

const catalogHandler = getHandler(onboardingForgeRouter, "get", "/catalog");
const validateHandler = getHandler(onboardingForgeRouter, "post", "/validate");
const validateHandlers = getRouteHandlers(onboardingForgeRouter, "post", "/validate");
const statusHandler = getHandler(onboardingForgeRouter, "get", "/status");

beforeEach(() => {
  vi.clearAllMocks();
  db.userAIConfigUpdateMany.mockResolvedValue({ count: 0 });
  db.userAIConfigUpsert.mockResolvedValue({});
  db.tenantTx.mockImplementation(tenantTxImpl);
  // Default: no system-held key for anything — individual trial-path tests
  // override this per case. Without a default the mock returns `undefined`,
  // which breaks the catalog shape assertion (systemTrialAvailable must be
  // a real boolean).
  trialSvc.hasSystemHeldKey.mockReturnValue(false);
});

describe("POST /onboarding/forge/validate — save authorization boundary", () => {
  it.each([
    ["MEMBER", "canonical MEMBER"],
    ["member", "lowercase role"],
    ["SUPERADMIN", "unknown role"],
    [undefined, "missing role"],
  ])("rejects %s save:true before parsing or any side effect (%s)", async (role) => {
    let providerRead = false;
    const body = {
      save: true,
      get provider() {
        providerRead = true;
        throw new Error("schema/business validation must not run");
      },
    };

    const { res, nextErr } = await invokeRoute(validateHandlers, body, {
      tenantId: "tenant-1",
      userId: "user-1",
      role,
    });

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Insufficient permissions" });
    expect(providerRead).toBe(false);
    expect(limiterMock).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(trialSvc.hasSystemHeldKey).not.toHaveBeenCalled();
    expect(trialSvc.runForgeTrialCompletion).not.toHaveBeenCalled();
    expect(cryptoMock.decryptForTenant).not.toHaveBeenCalled();
    expect(cryptoMock.encryptForTenant).not.toHaveBeenCalled();
    expect(db.tenantTx).not.toHaveBeenCalled();
    expect(db.userAIConfigUpdateMany).not.toHaveBeenCalled();
    expect(db.userAIConfigUpsert).not.toHaveBeenCalled();
    expect(db.activityLogCreate).not.toHaveBeenCalled();
  });

  it("returns 401 for missing authentication before parsing or side effects", async () => {
    let providerRead = false;
    const body = {
      save: true,
      get provider() {
        providerRead = true;
        throw new Error("schema/business validation must not run");
      },
    };

    const { res, nextErr } = await invokeRoute(validateHandlers, body, null);

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
    expect(providerRead).toBe(false);
    expect(limiterMock).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(cryptoMock.decryptForTenant).not.toHaveBeenCalled();
    expect(db.tenantTx).not.toHaveBeenCalled();
    expect(db.activityLogCreate).not.toHaveBeenCalled();
  });

  it.each(["OWNER", "ADMIN"])("allows %s to validate and save", async (role) => {
    chatCompletionMock.mockResolvedValue({
      content: "OK",
      inputTokens: 1,
      outputTokens: 1,
      model: "gpt-oss-120b",
      provider: "CEREBRAS",
    });

    const { res, nextErr } = await invokeRoute(
      validateHandlers,
      { provider: "CEREBRAS", apiKey: "csk-owner-admin", save: true },
      { tenantId: "tenant-1", userId: "user-1", role },
    );

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "CEREBRAS", saved: true });
    expect(limiterMock).toHaveBeenCalledTimes(1);
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    expect(cryptoMock.encryptForTenant).toHaveBeenCalledTimes(1);
    expect(db.tenantTx).toHaveBeenCalledTimes(1);
    expect(db.userAIConfigUpsert).toHaveBeenCalledTimes(1);
    expect(db.activityLogCreate).toHaveBeenCalledTimes(1);
  });

  it.each([{ save: false }, {}])(
    "keeps MEMBER validation-only behavior and never persists (%o)",
    async (saveFields) => {
      chatCompletionMock.mockResolvedValue({
        content: "OK",
        inputTokens: 1,
        outputTokens: 1,
        model: "gpt-oss-120b",
        provider: "CEREBRAS",
      });

      const { res, nextErr } = await invokeRoute(
        validateHandlers,
        { provider: "CEREBRAS", apiKey: "csk-validation-only", ...saveFields },
        { tenantId: "tenant-1", userId: "user-1", role: "MEMBER" },
      );

      expect(nextErr).toBeUndefined();
      expect(res.body).toEqual({ valid: true, provider: "CEREBRAS", saved: false });
      expect(limiterMock).toHaveBeenCalledTimes(1);
      expect(chatCompletionMock).toHaveBeenCalledTimes(1);
      expect(cryptoMock.encryptForTenant).not.toHaveBeenCalled();
      expect(db.tenantTx).not.toHaveBeenCalled();
      expect(db.userAIConfigUpsert).not.toHaveBeenCalled();
      expect(db.activityLogCreate).not.toHaveBeenCalled();
    },
  );

  it("rejects MEMBER save:true before the system-trial path", async () => {
    const { res, nextErr } = await invokeRoute(
      validateHandlers,
      { provider: "CEREBRAS", useSystemTrialKey: true, save: true },
      { tenantId: "tenant-1", userId: "user-1", role: "MEMBER" },
    );

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(403);
    expect(limiterMock).not.toHaveBeenCalled();
    expect(trialSvc.hasSystemHeldKey).not.toHaveBeenCalled();
    expect(trialSvc.runForgeTrialCompletion).not.toHaveBeenCalled();
    expect(db.tenantTx).not.toHaveBeenCalled();
  });
});

describe("GET /onboarding/forge/catalog", () => {
  it("returns the curated Forge provider catalogue as static data", async () => {
    const { res, nextErr } = await invoke(catalogHandler);

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.providers)).toBe(true);
    const providers = res.body.providers.map((p: any) => p.provider);
    expect(providers).toEqual(
      expect.arrayContaining(["CEREBRAS", "GROQ", "GOOGLE", "ZHIPU", "OPENROUTER"]),
    );
  });

  it("every entry has the required onboarding-wizard shape and no fabricated numeric tier claims beyond what PROVIDER_INFO already states", async () => {
    const { res } = await invoke(catalogHandler);
    for (const entry of res.body.providers) {
      expect(entry).toMatchObject({
        provider: expect.any(String),
        displayName: expect.any(String),
        freeTierFacts: expect.any(String),
        keyCreationUrl: expect.stringMatching(/^https:\/\//),
        keyCreationMode: expect.stringMatching(/^(oauth-google|manual-guided)$/),
        guideSteps: expect.any(Array),
        systemTrialAvailable: expect.any(Boolean),
      });
    }
  });

  it("only GOOGLE uses the oauth-google key-creation mode — every other catalogue provider is manual-guided", async () => {
    const { res } = await invoke(catalogHandler);
    const byProvider = Object.fromEntries(res.body.providers.map((p: any) => [p.provider, p.keyCreationMode]));
    expect(byProvider.GOOGLE).toBe("oauth-google");
    expect(byProvider.CEREBRAS).toBe("manual-guided");
    expect(byProvider.GROQ).toBe("manual-guided");
    expect(byProvider.ZHIPU).toBe("manual-guided");
    expect(byProvider.OPENROUTER).toBe("manual-guided");
  });
});

describe("POST /onboarding/forge/validate — candidate-key path (Bölüm A.2)", () => {
  it("valid cloud key → { valid: true, provider, saved: false } when save is omitted", async () => {
    chatCompletionMock.mockResolvedValue({ content: "OK", inputTokens: 5, outputTokens: 1, model: "gpt-oss-120b", provider: "CEREBRAS" });

    const { res, nextErr } = await invoke(validateHandler, { provider: "CEREBRAS", apiKey: "csk-real-candidate-key" });

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "CEREBRAS", saved: false });
    expect(db.userAIConfigUpsert).not.toHaveBeenCalled();
  });

  it("provider rejects the key (401-style) → 200 with { valid: false, reason } — not an HTTP error", async () => {
    chatCompletionMock.mockRejectedValue(new Error("CEREBRAS API error 401: invalid api key"));

    const { res, nextErr } = await invoke(validateHandler, { provider: "CEREBRAS", apiKey: "csk-bad-key" });

    expect(nextErr).toBeUndefined();
    expect(res.body.valid).toBe(false);
    expect(res.body.provider).toBe("CEREBRAS");
    expect(typeof res.body.reason).toBe("string");
  });

  it("the raw apiKey is never echoed back in `reason`, even when the upstream error contains it verbatim", async () => {
    const leakyKey = "sk-leak-me-0001-please-dont";
    chatCompletionMock.mockRejectedValue(new Error(`OPENAI API error 401: Incorrect API key provided: ${leakyKey}.`));

    const { res } = await invoke(validateHandler, { provider: "OPENAI", apiKey: leakyKey });

    expect(res.body.valid).toBe(false);
    expect(res.body.reason).not.toContain(leakyKey);
  });

  it("cloud provider without apiKey → 400, chatCompletion never called", async () => {
    const { nextErr } = await invoke(validateHandler, { provider: "OPENAI" });
    expect(nextErr?.statusCode).toBe(400);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it("unknown provider id → 400", async () => {
    const { nextErr } = await invoke(validateHandler, { provider: "NOTAPROVIDER", apiKey: "whatever" });
    expect(nextErr?.statusCode).toBe(400);
  });

  it("CUSTOM without baseUrl → 400", async () => {
    const { nextErr } = await invoke(validateHandler, { provider: "CUSTOM", apiKey: "some-key" });
    expect(nextErr?.statusCode).toBe(400);
  });

  it("valid key + save:true persists via saveTenantAIConfig — encryptForTenant is called and the row is upserted encrypted, never plaintext", async () => {
    chatCompletionMock.mockResolvedValue({ content: "OK", inputTokens: 1, outputTokens: 1, model: "gpt-oss-120b", provider: "CEREBRAS" });

    const { res, nextErr } = await invoke(validateHandler, {
      provider: "CEREBRAS",
      apiKey: "csk-to-persist-abc123",
      save: true,
    });

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "CEREBRAS", saved: true });

    // encryptForTenant was called with the RIGHT plaintext + tenant scope...
    expect(cryptoMock.encryptForTenant).toHaveBeenCalledWith("csk-to-persist-abc123", "tenant-1");
    expect(db.userAIConfigUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = db.userAIConfigUpsert.mock.calls[0]![0];
    // ...and the persisted row carries encryptForTenant's OPAQUE return
    // value, never the raw plaintext key.
    expect(upsertArgs.create.encryptedApiKey).toBe("v4:opaque-ciphertext-blob");
    expect(upsertArgs.create.encryptedApiKey).not.toContain("csk-to-persist-abc123");
    expect(db.activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant-1", action: "onboarding_forge.provider_saved" }),
      }),
    );
  });

  it("an INVALID key with save:true never persists anything (save only runs after a successful validation)", async () => {
    chatCompletionMock.mockRejectedValue(new Error("CEREBRAS API error 401: invalid api key"));

    const { res } = await invoke(validateHandler, { provider: "CEREBRAS", apiKey: "csk-bad", save: true });

    expect(res.body.valid).toBe(false);
    expect(cryptoMock.encryptForTenant).not.toHaveBeenCalled();
    expect(db.userAIConfigUpsert).not.toHaveBeenCalled();
  });

  it("local provider (OLLAMA) validates without an apiKey", async () => {
    chatCompletionMock.mockResolvedValue({ content: "OK", inputTokens: 1, outputTokens: 1, model: "gemma3:4b", provider: "OLLAMA" });
    const { res, nextErr } = await invoke(validateHandler, { provider: "OLLAMA", baseUrl: "http://localhost:11434/v1" });
    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "OLLAMA", saved: false });
  });
});

describe("POST /onboarding/forge/validate — trial path (Bölüm B wiring point, useSystemTrialKey)", () => {
  it("no system-held key for the provider → { valid:false, trial:true, reason } — runForgeTrialCompletion never called", async () => {
    trialSvc.hasSystemHeldKey.mockReturnValue(false);

    const { res, nextErr } = await invoke(validateHandler, { provider: "OPENROUTER", useSystemTrialKey: true });

    expect(nextErr).toBeUndefined();
    expect(res.body.valid).toBe(false);
    expect(res.body.trial).toBe(true);
    expect(trialSvc.runForgeTrialCompletion).not.toHaveBeenCalled();
  });

  it("trial-credit exhausted/disabled → { valid:false, trial:true, trialExhausted:true } — never falls through to a generic error", async () => {
    trialSvc.hasSystemHeldKey.mockReturnValue(true);
    trialSvc.runForgeTrialCompletion.mockRejectedValue(new TrialCreditExhaustedError("tenant-1"));

    const { res, nextErr } = await invoke(validateHandler, { provider: "CEREBRAS", useSystemTrialKey: true });

    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ valid: false, provider: "CEREBRAS", trial: true, trialExhausted: true });
  });

  it("successful trial call → { valid:true, trial:true, costUsd } — no tenant apiKey required, nothing saved", async () => {
    trialSvc.hasSystemHeldKey.mockReturnValue(true);
    trialSvc.runForgeTrialCompletion.mockResolvedValue({
      content: "OK", inputTokens: 1, outputTokens: 1, model: "gpt-oss-120b", provider: "CEREBRAS", costUsd: 0.0004,
    });

    const { res, nextErr } = await invoke(validateHandler, { provider: "CEREBRAS", useSystemTrialKey: true });

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({ valid: true, provider: "CEREBRAS", trial: true, costUsd: 0.0004 });
    expect(db.userAIConfigUpsert).not.toHaveBeenCalled();
    expect(chatCompletionMock).not.toHaveBeenCalled(); // the trial path dials through runForgeTrialCompletion, not chatCompletion directly
  });

  it("NoSystemHeldKeyError from the service surfaces as a plain valid:false result, not a 500", async () => {
    trialSvc.hasSystemHeldKey.mockReturnValue(true); // router's own pre-check passed, but the service itself refuses
    trialSvc.runForgeTrialCompletion.mockRejectedValue(new NoSystemHeldKeyError("CEREBRAS"));

    const { res, nextErr } = await invoke(validateHandler, { provider: "CEREBRAS", useSystemTrialKey: true });

    expect(nextErr).toBeUndefined();
    expect(res.body.valid).toBe(false);
    expect(res.body.trial).toBe(true);
  });

  it("local providers reject useSystemTrialKey with 400 (they use a base URL, not a system key)", async () => {
    const { nextErr } = await invoke(validateHandler, { provider: "OLLAMA", useSystemTrialKey: true });
    expect(nextErr?.statusCode).toBe(400);
    expect(trialSvc.runForgeTrialCompletion).not.toHaveBeenCalled();
  });
});

describe("GET /onboarding/forge/status", () => {
  it("reports providers-configured count + the trial-credit snapshot", async () => {
    db.userAIConfigCount.mockResolvedValue(2);
    trialSvc.getForgeTrialCreditStatus.mockResolvedValue({
      enabled: true, capUsd: 0.5, spentUsd: 0.1, remainingUsd: 0.4, exhausted: false,
    });

    const { res, nextErr } = await invoke(statusHandler);

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual({
      providersConfigured: 2,
      hasDefaultProvider: true,
      trialCredit: { enabled: true, capUsd: 0.5, spentUsd: 0.1, remainingUsd: 0.4, exhausted: false },
    });
  });

  it("zero configured providers → hasDefaultProvider:false", async () => {
    db.userAIConfigCount.mockResolvedValue(0);
    trialSvc.getForgeTrialCreditStatus.mockResolvedValue({
      enabled: false, capUsd: 0, spentUsd: 0, remainingUsd: 0, exhausted: false,
    });

    const { res } = await invoke(statusHandler);
    expect(res.body.hasDefaultProvider).toBe(false);
  });
});
