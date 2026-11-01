/** Durable relay registry: pure store + cache-merge rules, against a tiny in-memory Redis. */
import { describe, expect, it, vi } from "vitest";
import { createRelayState, type SessionRecord } from "../relay.core";
import { createRedisRegistryStore, forgetSessions, hydrateSession, hydrateTenant, persistSession, REGISTRY_ACTIVE_TTL_SECONDS, REGISTRY_ENDED_TTL_SECONDS } from "../registry-store";

function memoryRedis() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const ttl = new Map<string, number>();
  return {
    strings, sets, ttl,
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string, _mode: "EX", s: number) => { strings.set(k, v); ttl.set(k, s); return "OK"; },
    del: async (k: string) => { strings.delete(k); return 1; },
    sadd: async (k: string, m: string) => { sets.set(k, (sets.get(k) ?? new Set()).add(m)); return 1; },
    srem: async (k: string, m: string) => { sets.get(k)?.delete(m); return 1; },
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    expire: async (k: string, s: number) => { ttl.set(k, s); return 1; },
  };
}

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "sess_1", tenantId: "t1", userId: "u1", surface: "cli", status: "active",
  createdAt: "2026-10-31T00:00:00.000Z", sequence: { events: 3, commands: 1 }, ...over,
});
const warn = vi.fn();

describe("redis registry store", () => {
  it("round-trips records under tenant-namespaced keys with active/ended TTLs", async () => {
    const r = memoryRedis(); const store = createRedisRegistryStore(r);
    await store.save(record());
    expect(r.ttl.get("relay:registry:t1:session:sess_1")).toBe(REGISTRY_ACTIVE_TTL_SECONDS);
    expect(r.ttl.get("relay:registry:t1:index")).toBe(REGISTRY_ACTIVE_TTL_SECONDS);
    expect(await store.load("t1", "sess_1")).toEqual(record());
    await store.save(record({ status: "ended" }));
    expect(r.ttl.get("relay:registry:t1:session:sess_1")).toBe(REGISTRY_ENDED_TTL_SECONDS);
    await store.remove("t1", "sess_1");
    expect(await store.load("t1", "sess_1")).toBeUndefined();
    expect(await store.loadTenant("t1")).toEqual([]);
  });

  it("never returns another tenant's record or a malformed one", async () => {
    const r = memoryRedis(); const store = createRedisRegistryStore(r);
    expect(await store.load("t2", "sess_1")).toBeUndefined();
    // A record planted under t2's key that claims t1 is refused.
    r.strings.set("relay:registry:t2:session:sess_1", JSON.stringify(record()));
    expect(await store.load("t2", "sess_1")).toBeUndefined();
    r.strings.set("relay:registry:t1:session:sess_1", "{not json");
    expect(await store.load("t1", "sess_1")).toBeUndefined();
    r.strings.set("relay:registry:t1:session:sess_1", JSON.stringify({ ...record(), sequence: { events: -1, commands: 0 } }));
    expect(await store.load("t1", "sess_1")).toBeUndefined();
  });

  it("drops dangling index entries whose record expired", async () => {
    const r = memoryRedis(); const store = createRedisRegistryStore(r);
    await store.save(record()); await store.save(record({ sessionId: "sess_2" }));
    r.strings.delete("relay:registry:t1:session:sess_1"); // TTL elapsed
    expect((await store.loadTenant("t1")).map(s => s.sessionId)).toEqual(["sess_2"]);
    expect([...r.sets.get("relay:registry:t1:index")!]).toEqual(["sess_2"]);
  });
});

describe("cache merge rules", () => {
  it("hydrates a missing record and merges cursors forward without reviving ended sessions", async () => {
    const r = memoryRedis(); const store = createRedisRegistryStore(r);
    const state = createRelayState();
    await store.save(record({ sequence: { events: 5, commands: 2 } }));
    await hydrateSession(state, store, "t1", "sess_1", warn);
    expect(state.sessions.get("sess_1")!.sequence).toEqual({ events: 5, commands: 2 });

    const cached = state.sessions.get("sess_1")!;
    cached.sequence.events = 9; cached.status = "ended";
    await store.save(record({ sequence: { events: 6, commands: 4 }, status: "active" }));
    await hydrateSession(state, store, "t1", "sess_1", warn);
    expect(cached.sequence).toEqual({ events: 9, commands: 4 });
    expect(cached.status).toBe("ended");
  });

  it("never lets stored data rebind ownership of a cached session", async () => {
    const r = memoryRedis(); const store = createRedisRegistryStore(r);
    const state = createRelayState();
    state.sessions.set("sess_1", record({ userId: "owner", sequence: { events: 1, commands: 1 } }));
    await store.save(record({ userId: "attacker", sequence: { events: 50, commands: 50 } }));
    await hydrateTenant(state, store, "t1", warn);
    expect(state.sessions.get("sess_1")).toMatchObject({ userId: "owner", sequence: { events: 1, commands: 1 } });
  });

  it("persists only the record the cache still holds (no resurrection after eviction)", async () => {
    const r = memoryRedis(); const store = createRedisRegistryStore(r);
    const state = createRelayState();
    const live = record();
    state.sessions.set(live.sessionId, live);
    await persistSession(state, store, live, warn);
    expect(await store.load("t1", "sess_1")).toEqual(live);
    state.sessions.delete(live.sessionId);
    await forgetSessions(store, "t1", [live.sessionId], warn);
    await persistSession(state, store, live, warn); // late in-flight publish
    expect(await store.load("t1", "sess_1")).toBeUndefined();
  });

  it("logs and continues when Redis fails", async () => {
    const broken = { ...memoryRedis(), get: async () => { throw new Error("down"); }, smembers: async () => { throw new Error("down"); } };
    const store = createRedisRegistryStore(broken);
    const state = createRelayState();
    const w = vi.fn();
    await hydrateSession(state, store, "t1", "sess_1", w);
    await hydrateTenant(state, store, "t1", w);
    expect(state.sessions.size).toBe(0);
    expect(w).toHaveBeenCalledTimes(2);
  });
});
