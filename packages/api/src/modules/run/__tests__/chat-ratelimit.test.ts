/** BRA-UX-API-05 — sohbet limiter'ı: GERÇEK rateLimit middleware'i + sahte Redis sayacı. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({ n: new Map<string, number>(), down: false }));
vi.mock("../../../lib/redis", () => ({
  redis: {
    incr: async (k: string) => { if (store.down) throw new Error("redis down"); const v = (store.n.get(k) ?? 0) + 1; store.n.set(k, v); return v; },
    expire: async () => 1,
  },
}));
import { rateLimit } from "../../../middleware/rateLimit";
import { CHAT_RATE_LIMIT } from "../chat";

const mk = () => rateLimit(CHAT_RATE_LIMIT as any); // router.ts aynı sabiti kullanır
async function hit(mw: any, tenantId: string, userId: string) {
  const res: any = { code: 200, setHeader() {}, status(c: number) { this.code = c; return this; }, json() { return this; } };
  let passed = false;
  await mw({ auth: { tenantId, userId }, ip: "1.1.1.1" }, res, () => { passed = true; });
  return { passed, code: res.code };
}
beforeEach(() => { store.n.clear(); store.down = false; });

describe("chat limiter", () => {
  it("30/dk geçer, 31. istek 429", async () => {
    const mw = mk();
    for (let i = 0; i < 30; i++) expect((await hit(mw, "t1", "u1")).passed).toBe(true);
    const r = await hit(mw, "t1", "u1");
    expect(r.passed).toBe(false); expect(r.code).toBe(429);
  });
  it("anahtar tenantId:userId: bir üye dolunca aynı kiracıdaki diğer üye ve başka kiracı etkilenmez", async () => {
    const mw = mk();
    for (let i = 0; i < 31; i++) await hit(mw, "t1", "u1");
    expect((await hit(mw, "t1", "u2")).passed).toBe(true);
    expect((await hit(mw, "t2", "u1")).passed).toBe(true);
    expect([...store.n.keys()]).toContain("rl:run:chat:t1:u1");
  });
  it("Redis çökünce fail-CLOSED: 503, handler'a geçmez", async () => {
    store.down = true;
    const r = await hit(mk(), "t1", "u1");
    expect(r.passed).toBe(false); expect(r.code).toBe(503);
  });
});
