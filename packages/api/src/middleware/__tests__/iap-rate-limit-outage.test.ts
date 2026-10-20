import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ incr: vi.fn(), expire: vi.fn() }));
vi.mock("../../lib/redis", () => ({ redis: m }));
import { rateLimit } from "../rateLimit";

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
}
beforeEach(() => { vi.resetAllMocks(); m.incr.mockResolvedValue(1); m.expire.mockResolvedValue(1); });

describe("existing IAP limiter outage contract", () => {
  for (const prefix of ["rl:iap:verify", "rl:iap:entitlement", "rl:iap:webhook"]) {
    for (const phase of ["incr", "expire"] as const) {
      it(`${prefix} stops before the provider when Redis ${phase} fails`, async () => {
        m[phase].mockRejectedValue(new Error("synthetic Redis unavailable"));
        const res = response(); const provider = vi.fn();
        await rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: prefix })({ auth: { tenantId: "fixture" } } as any, res as any, provider);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(provider).not.toHaveBeenCalled();
      });
    }
  }
  it("preserves normal IAP requests and their existing bucket headers", async () => {
    const res = response(); const next = vi.fn();
    await rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "rl:iap:verify" })({ auth: { tenantId: "fixture" } } as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 19);
  });
  it("preserves the ordinary low-impact limiter fail-open policy", async () => {
    m.incr.mockRejectedValue(new Error("synthetic Redis unavailable"));
    const res = response(); const next = vi.fn();
    await rateLimit({ windowMs: 60_000, maxRequests: 20, keyPrefix: "rl:read" })({ ip: "fixture" } as any, res as any, next);
    expect(next).toHaveBeenCalledOnce(); expect(res.status).not.toHaveBeenCalled();
  });
});
