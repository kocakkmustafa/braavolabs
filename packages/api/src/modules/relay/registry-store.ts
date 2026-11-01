/**
 * Durable relay session registry (plan item 1.6).
 *
 * relay.core.ts keeps every tenant/owner decision as a pure, synchronous
 * function over the in-memory `RelayState` map. This module makes that map a
 * write-through CACHE of a Redis-backed registry, without changing a single
 * core signature: the router hydrates the records a request needs before it
 * calls the core, and persists the records the core (or bus.ts's sequence
 * reservation) mutated afterwards. A process restart or a second API instance
 * therefore sees the same sessions, owners, lifecycle and cursors.
 *
 * Keys are tenant-namespaced (same defense-in-depth as bus.ts's buffer keys):
 *   relay:registry:<tenantId>:session:<sessionId>  JSON SessionRecord
 *   relay:registry:<tenantId>:index                 SET of sessionIds
 * Every key carries a TTL — 24h sliding for active sessions (refreshed on each
 * write), 1h once ended — so the registry never leaves permanent keys.
 *
 * Failure mode: a Redis error is logged and the request continues on the
 * in-memory map, i.e. exactly the pre-1.6 single-process behaviour. A record
 * read back from Redis is schema-checked and must match the requested tenant.
 *
 * Known limit: sequence cursors are merged by max on hydration, which is
 * correct for one writer per session (sticky routing). Two instances
 * publishing into the SAME session concurrently would need Redis-side cursor
 * reservation; that is a later step, not this one.
 */
import { z } from "zod";
import type { RelayState, SessionRecord } from "./relay.core";
import { SURFACES } from "./protocol";

export const REGISTRY_ACTIVE_TTL_SECONDS = 86_400;
export const REGISTRY_ENDED_TTL_SECONDS = 3600;

export interface RegistryRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RelayRegistryStore {
  load(tenantId: string, sessionId: string): Promise<SessionRecord | undefined>;
  loadTenant(tenantId: string): Promise<SessionRecord[]>;
  save(record: SessionRecord): Promise<void>;
  remove(tenantId: string, sessionId: string): Promise<void>;
}

const sessionKey = (tenantId: string, sessionId: string) => `relay:registry:${tenantId}:session:${sessionId}`;
const indexKey = (tenantId: string) => `relay:registry:${tenantId}:index`;

const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SessionRecordSchema = z.object({
  sessionId: z.string().min(1).max(200),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  surface: z.enum(SURFACES),
  label: z.string().optional(),
  cwd: z.string().optional(),
  status: z.enum(["active", "ended"]),
  createdAt: z.string(),
  sequence: z.object({ events: cursor, commands: cursor }),
});

function parseRecord(raw: string | null, tenantId: string, sessionId: string): SessionRecord | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const parsed = SessionRecordSchema.safeParse(value);
  if (!parsed.success) return undefined;
  // A record stored under one tenant's key must describe that tenant and session.
  if (parsed.data.tenantId !== tenantId || parsed.data.sessionId !== sessionId) return undefined;
  return parsed.data as SessionRecord;
}

export function createRedisRegistryStore(client: RegistryRedis): RelayRegistryStore {
  return {
    async load(tenantId, sessionId) {
      return parseRecord(await client.get(sessionKey(tenantId, sessionId)), tenantId, sessionId);
    },
    async loadTenant(tenantId) {
      const ids = await client.smembers(indexKey(tenantId));
      const records: SessionRecord[] = [];
      for (const id of ids) {
        const record = parseRecord(await client.get(sessionKey(tenantId, id)), tenantId, id);
        if (record) records.push(record);
        else await client.srem(indexKey(tenantId), id); // expired or invalid: drop the dangling index entry
      }
      return records;
    },
    async save(record) {
      const ttl = record.status === "ended" ? REGISTRY_ENDED_TTL_SECONDS : REGISTRY_ACTIVE_TTL_SECONDS;
      await client.set(sessionKey(record.tenantId, record.sessionId), JSON.stringify(record), "EX", ttl);
      await client.sadd(indexKey(record.tenantId), record.sessionId);
      await client.expire(indexKey(record.tenantId), REGISTRY_ACTIVE_TTL_SECONDS);
    },
    async remove(tenantId, sessionId) {
      await client.del(sessionKey(tenantId, sessionId));
      await client.srem(indexKey(tenantId), sessionId);
    },
  };
}

type Warn = (context: Record<string, unknown>, message: string) => void;

function adopt(state: RelayState, stored: SessionRecord): void {
  const cached = state.sessions.get(stored.sessionId);
  if (!cached) { state.sessions.set(stored.sessionId, stored); return; }
  if (cached.tenantId !== stored.tenantId || cached.userId !== stored.userId) return; // never let storage rebind ownership
  // Cursors only move forward; an ended session never comes back to life. A cached
  // cursor that is already invalid stays invalid so bus.ts keeps failing closed.
  for (const direction of ["events", "commands"] as const) {
    const current = cached.sequence[direction];
    if (Number.isSafeInteger(current) && current >= 0) cached.sequence[direction] = Math.max(current, stored.sequence[direction]);
  }
  if (stored.status === "ended") cached.status = "ended";
}

/** Make sure the one record a request is about is in the cache (no-op on Redis failure). */
export async function hydrateSession(state: RelayState, store: RelayRegistryStore, tenantId: string, sessionId: string, warn: Warn): Promise<void> {
  try {
    const stored = await store.load(tenantId, sessionId);
    if (stored) adopt(state, stored);
  } catch (err) {
    warn({ tenantId, sessionId, err: (err as Error).message }, "relay registry load failed; using in-memory registry");
  }
}

/** Load every stored session of a tenant into the cache (cap accounting and listing). */
export async function hydrateTenant(state: RelayState, store: RelayRegistryStore, tenantId: string, warn: Warn): Promise<void> {
  try {
    for (const stored of await store.loadTenant(tenantId)) adopt(state, stored);
  } catch (err) {
    warn({ tenantId, err: (err as Error).message }, "relay registry tenant load failed; using in-memory registry");
  }
}

/**
 * Persist a record the request mutated — only while the cache still holds that
 * exact record, so an in-flight publish finishing after eviction cannot
 * resurrect the evicted session in storage.
 */
export async function persistSession(state: RelayState, store: RelayRegistryStore, record: SessionRecord, warn: Warn): Promise<void> {
  if (state.sessions.get(record.sessionId) !== record) return;
  try { await store.save(record); } catch (err) {
    warn({ tenantId: record.tenantId, sessionId: record.sessionId, err: (err as Error).message }, "relay registry save failed");
  }
}

export async function forgetSessions(store: RelayRegistryStore, tenantId: string, sessionIds: Iterable<string>, warn: Warn): Promise<void> {
  for (const sessionId of sessionIds) {
    try { await store.remove(tenantId, sessionId); } catch (err) {
      warn({ tenantId, sessionId, err: (err as Error).message }, "relay registry remove failed");
    }
  }
}
