import { beforeEach, describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({ google: vi.fn(), github: vi.fn(), apple: vi.fn(), stash: vi.fn() }));
const cache = vi.hoisted(() => ({ call: vi.fn(), get: vi.fn(), del: vi.fn() }));
vi.mock("../auth.service", () => ({
  googleCallback: callbacks.google, githubCallback: callbacks.github, appleWebCallback: callbacks.apple,
  stashOAuthExchange: callbacks.stash,
}));
vi.mock("../../../lib/redis", () => ({ redis: cache }));
vi.mock("../../../lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "test", APP_URL: "https://example.invalid" } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => vi.fn() }));

import { authRouter } from "../auth.router";
const state = "a".repeat(64);
let keys: Map<string, string>;
beforeEach(() => {
  vi.resetAllMocks();
  keys = new Map([[`oauth:state:${state}`, "1"]]);
  cache.get.mockImplementation(async (key: string) => keys.get(key) ?? null);
  cache.del.mockImplementation(async (key: string) => Number(keys.delete(key)));
  cache.call.mockImplementation(async (command: string, key: string) => {
    expect(command).toBe("GETDEL");
    const value = keys.get(key) ?? null; keys.delete(key); return value;
  });
  for (const callback of [callbacks.google, callbacks.github, callbacks.apple]) callback.mockResolvedValue({ token: "synthetic" });
  callbacks.stash.mockResolvedValue("synthetic-exchange");
});

const providers = ["google", "github", "apple"] as const;
async function invoke(provider: typeof providers[number], cookie: string | null = state) {
  const layer = (authRouter as any).stack.find((l: any) => l.route?.path === `/${provider}/callback`);
  const res = { statusCode: 200, body: undefined as any, redirectUrl: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    redirect(url: string) { this.redirectUrl = url; }, clearCookie: vi.fn() };
  let error: any;
  await layer.route.stack.at(-1).handle({
    query: { code: "synthetic-code", state }, body: { id_token: "synthetic-apple-token-12345", state },
    headers: cookie === null ? {} : { cookie: `bv_oauth_state_${provider}=${encodeURIComponent(cookie)}` },
  }, res, (err: any) => { error = err; });
  return { res, error };
}

describe.each(providers)("%s browser OAuth state", provider => {
  it("allows one concurrent callback and rejects replay before invoking the provider", async () => {
    const results = await Promise.all([invoke(provider), invoke(provider)]);
    expect(results.filter(r => r.res.redirectUrl)).toHaveLength(1);
    expect(results.filter(r => r.res.statusCode === 400)).toHaveLength(1);
    expect(callbacks[provider]).toHaveBeenCalledOnce();
    expect(callbacks.stash).toHaveBeenCalledOnce();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it.each([null, "wrong", "é".repeat(64)])("rejects missing/mismatched/multibyte browser binding without consuming server state", async cookie => {
    const { res, error } = await invoke(provider, cookie);
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(cache.call).not.toHaveBeenCalled();
    expect(keys.get(`oauth:state:${state}`)).toBe("1");
    expect(callbacks[provider]).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledOnce();
  });

  it("fails closed when atomic Redis consumption is unavailable", async () => {
    cache.call.mockRejectedValueOnce(new Error("unsupported or unavailable"));
    const { error } = await invoke(provider);
    expect(error).toMatchObject({ statusCode: 503 });
    expect(callbacks[provider]).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });
});
