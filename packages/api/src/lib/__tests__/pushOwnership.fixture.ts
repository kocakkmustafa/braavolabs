/**
 * Test-only SQL model. This is deliberately not a PostgreSQL/RLS substitute.
 * It executes only the adapter's complete, parameterized statements, checks
 * declared tenant context, and holds session/fence locks until transaction end.
 */
import assert from "node:assert/strict";
import { currentTenantContext, type TenantContext } from "../tenant-context";
import type { PushActor, PushDevice } from "../pushOwnership";

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
export const SQL = Object.fromEntries(Object.entries({
  advisory: "SELECT pg_advisory_xact_lock(1934884, 1)",
  userLock: "SELECT id FROM users WHERE id = $1 AND tenant_id = $2 FOR KEY SHARE",
  create: `INSERT INTO push_sessions (id, user_id, tenant_id, expires_at)
    SELECT $1, id, tenant_id, $2 FROM users WHERE id = $3 AND tenant_id = $4 RETURNING id`,
  renew: `UPDATE push_sessions SET expires_at = GREATEST(expires_at, $1)
    WHERE id = $2 AND user_id = $3 AND tenant_id = $4 AND expires_at > clock_timestamp() RETURNING id`,
  gcSessions: `DELETE FROM push_sessions WHERE id IN (
    SELECT id FROM push_sessions WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED )`,
  gcFences: `DELETE FROM push_token_fences WHERE token_hash IN (
    SELECT f.token_hash FROM push_token_fences f
    WHERE NOT EXISTS (SELECT 1 FROM push_sessions s
    WHERE s.login_order <= f.login_order AND s.expires_at > clock_timestamp())
    ORDER BY f.token_hash LIMIT 100 FOR UPDATE OF f SKIP LOCKED )`,
  session: `SELECT s.id, s.login_order AS "loginOrder", s.revision, s.token_hash AS "tokenHash"
    FROM push_sessions s JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
    WHERE s.id = $1 AND s.user_id = $2 AND s.tenant_id = $3 AND s.expires_at > clock_timestamp() FOR UPDATE OF s`,
  fenceInsert: `INSERT INTO push_token_fences (token_hash) VALUES ($1) ON CONFLICT DO NOTHING`,
  fence: `SELECT login_order AS "loginOrder", session_id AS "sessionId", revision
    FROM push_token_fences WHERE token_hash = $1 FOR UPDATE`,
  live: `SELECT id FROM push_sessions WHERE id = $1 AND user_id = $2 AND tenant_id = $3 AND expires_at > clock_timestamp()`,
  duplicate: `SELECT id FROM devices WHERE user_id = $1 AND push_session_id = $2
    AND push_token_hash = $3 AND push_revision = $4 AND push_payload_hash = $5`,
  advanceSession: `UPDATE push_sessions SET revision = $1, token_hash = $2
    WHERE id = $3 AND user_id = $4 AND tenant_id = $5`,
  advanceFence: `UPDATE push_token_fences SET login_order = $1, session_id = $2, revision = $3 WHERE token_hash = $4`,
  deletePrevious: `DELETE FROM devices WHERE user_id = $1 AND push_session_id = $2 AND push_token_hash <> $3`,
  upsert: `INSERT INTO devices (id, user_id, push_token, platform, device_name, os_version, locale,
    push_session_id, push_revision, push_token_hash, push_payload_hash, last_seen_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
    clock_timestamp(), clock_timestamp(), clock_timestamp())
    ON CONFLICT (push_token_hash, push_session_id) DO UPDATE SET platform = EXCLUDED.platform,
    device_name = EXCLUDED.device_name, os_version = EXCLUDED.os_version, locale = EXCLUDED.locale,
    push_revision = EXCLUDED.push_revision, push_payload_hash = EXCLUDED.push_payload_hash,
    last_seen_at = clock_timestamp(), updated_at = clock_timestamp()`,
  retireLock: `SELECT id FROM push_sessions WHERE id = $1 AND user_id = $2 AND tenant_id = $3 FOR UPDATE`,
  retire: `DELETE FROM push_sessions WHERE id = $1 AND user_id = $2 AND tenant_id = $3`,
  locale: `UPDATE devices SET locale = $1, updated_at = clock_timestamp()
    WHERE user_id = $2 AND push_session_id = $3 AND push_token_hash = $4 AND push_revision = $5`,
  legacyDelete: `DELETE FROM devices WHERE user_id = $1 AND push_token = $2 AND push_session_id IS NULL`,
  current: `SELECT d.id, d.push_token AS "pushToken", d.locale, d.user_id AS "userId",
    d.push_session_id AS "pushSessionId", d.push_revision AS "pushRevision", d.push_token_hash AS "pushTokenHash"
    FROM devices d JOIN push_sessions s ON s.id = d.push_session_id AND s.user_id = d.user_id
    JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
    JOIN push_token_fences f ON f.token_hash = d.push_token_hash AND f.session_id = s.id
    WHERE d.user_id = $1 AND s.expires_at > clock_timestamp()
    AND s.token_hash = d.push_token_hash AND s.revision = d.push_revision AND f.revision = d.push_revision`,
  deliverySession: `SELECT id FROM push_sessions WHERE id = $1 FOR UPDATE`,
  deliveryFence: `SELECT token_hash FROM push_token_fences WHERE token_hash = $1 FOR UPDATE`,
  deliveryLive: `SELECT d.id FROM devices d JOIN push_sessions s ON s.id = d.push_session_id AND s.user_id = d.user_id
    JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
    JOIN push_token_fences f ON f.token_hash = d.push_token_hash AND f.session_id = s.id
    WHERE d.id = $1 AND d.user_id = $2 AND d.push_session_id = $3 AND d.push_revision = $4
    AND s.expires_at > clock_timestamp() AND s.token_hash = d.push_token_hash
    AND s.revision = d.push_revision AND f.revision = d.push_revision`,
  deadDelete: `DELETE FROM devices WHERE id = $1 AND user_id = $2 AND push_session_id = $3 AND push_revision = $4`,
}).map(([key, sql]) => [key, normalize(sql)])) as Record<
  "advisory" | "userLock" | "create" | "renew" | "gcSessions" | "gcFences" | "session" | "fenceInsert" | "fence" |
  "live" | "duplicate" | "advanceSession" | "advanceFence" | "deletePrevious" | "upsert" | "retireLock" |
  "retire" | "locale" | "legacyDelete" | "current" | "deliverySession" | "deliveryFence" | "deliveryLive" | "deadDelete", string>;

export function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface Session {
  id: string; userId: string; tenantId: string; expiresAt: number;
  loginOrder: bigint; revision: number; tokenHash: string | null;
}
interface Fence { loginOrder: bigint; sessionId: string | null; revision: number }
interface Device {
  id: string; userId: string; pushToken: string; locale: string; platform: string;
  deviceName: string | null; osVersion: string | null; payloadHash: string | null;
  pushSessionId: string | null; pushRevision: number | null; pushTokenHash: string | null;
}
interface Transaction {
  id: number; context: TenantContext; locks: Set<string>; undo: Array<() => void>;
}
interface Lock { owner: number; queue: Array<{ tx: Transaction; ready: ReturnType<typeof latch> }> }

export class PushSqlStore {
  now = Date.UTC(2026, 9, 20, 12);
  users = new Map<string, string>();
  sessions = new Map<string, Session>();
  fences = new Map<string, Fence>();
  devices = new Map<string, Device>();
  trace: Array<{ sql: string; parameters: unknown[]; context: TenantContext; tx: number }> = [];
  private nextOrder = 0n;
  private nextTx = 0;
  private locks = new Map<string, Lock>();
  private blocked = new Map<string, ReturnType<typeof latch>>();
  private gates = new Map<string, { entered: ReturnType<typeof latch>; released: ReturnType<typeof latch> }>();

  addUser(actor: PushActor) { this.users.set(actor.userId, actor.tenantId); }
  deleteUser(userId: string) {
    // Model the schema's FK cascades, rather than inventing a users JOIN for
    // renewal/retirement statements which do not contain one.
    for (const s of this.sessions.values()) if (s.userId === userId) this.sessions.delete(s.id);
    for (const d of this.devices.values()) if (d.userId === userId) this.devices.delete(d.id);
    this.users.delete(userId);
  }
  expiry(offset = 60_000) { return new Date(this.now + offset); }
  blockedOn(key: string) {
    const event = latch();
    assert(!this.blocked.has(key), `one waiter observer for ${key}`);
    this.blocked.set(key, event);
    return event.promise;
  }
  holdNext(sql: string) {
    assert(!this.gates.has(sql));
    const entered = latch(), released = latch();
    this.gates.set(sql, { entered, released });
    return { entered: entered.promise, release: released.resolve };
  }
  legacy(userId: string, pushToken: string) {
    const id = `legacy-${this.devices.size}`;
    this.devices.set(id, { id, userId, pushToken, locale: "en", platform: "ios", deviceName: null,
      osVersion: null, payloadHash: null, pushSessionId: null, pushRevision: null, pushTokenHash: null });
    return id;
  }

  transaction = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    const context = currentTenantContext();
    assert(context, "every adapter transaction must declare tenant/system context");
    const tx: Transaction = { id: ++this.nextTx, context, locks: new Set(), undo: [] };
    try {
      return await fn({
        $queryRaw: (parts: TemplateStringsArray, ...parameters: unknown[]) => this.raw(tx, "query", parts, parameters),
        $executeRaw: (parts: TemplateStringsArray, ...parameters: unknown[]) => this.raw(tx, "execute", parts, parameters),
      });
    } catch (error) {
      for (const undo of tx.undo.reverse()) undo();
      throw error;
    } finally {
      for (const key of tx.locks) {
        const lock = this.locks.get(key)!;
        assert.equal(lock.owner, tx.id);
        const next = lock.queue.shift();
        if (next) {
          lock.owner = next.tx.id;
          next.tx.locks.add(key);
          next.ready.resolve();
        } else this.locks.delete(key);
      }
    }
  };

  private async lock(tx: Transaction, key: string) {
    if (tx.locks.has(key)) return;
    const held = this.locks.get(key);
    if (!held) {
      this.locks.set(key, { owner: tx.id, queue: [] });
      tx.locks.add(key);
      return;
    }
    const ready = latch();
    held.queue.push({ tx, ready });
    this.blocked.get(key)?.resolve();
    this.blocked.delete(key);
    await ready.promise;
  }
  private set<K, V>(tx: Transaction, map: Map<K, V>, key: K, value: V) {
    const previous = map.get(key);
    tx.undo.push(() => { if (previous === undefined) map.delete(key); else map.set(key, previous); });
    map.set(key, value);
  }
  private remove<K, V>(tx: Transaction, map: Map<K, V>, key: K) {
    const previous = map.get(key);
    if (previous === undefined) return 0;
    tx.undo.push(() => map.set(key, previous));
    map.delete(key);
    return 1;
  }
  private visible(tx: Transaction, userId: string) {
    return this.users.has(userId) && (tx.context.kind === "system" || this.users.get(userId) === tx.context.tenantId);
  }
  private scope(tx: Transaction, tenantId: unknown) {
    assert.equal(typeof tenantId, "string");
    if (tx.context.kind === "tenant") assert.equal(tenantId, tx.context.tenantId, "SQL tenant parameter must match transaction binding");
  }
  private session(tx: Transaction, id: unknown, userId: unknown, tenantId: unknown, live: boolean, joinUsers = false) {
    this.scope(tx, tenantId);
    const s = this.sessions.get(String(id));
    return s && s.userId === userId && s.tenantId === tenantId
      && (!joinUsers || this.users.get(s.userId) === s.tenantId)
      && (!live || s.expiresAt > this.now) ? s : undefined;
  }
  private current(tx: Transaction, d: Device) {
    if (!d.pushSessionId || !d.pushTokenHash || !this.visible(tx, d.userId)) return false;
    const s = this.sessions.get(d.pushSessionId), f = this.fences.get(d.pushTokenHash);
    return !!s && !!f && s.userId === d.userId && this.users.get(s.userId) === s.tenantId
      && s.expiresAt > this.now && s.tokenHash === d.pushTokenHash && s.revision === d.pushRevision
      && f.sessionId === s.id && f.revision === d.pushRevision;
  }
  private publicDevice(d: Device): PushDevice {
    assert(d.pushSessionId && d.pushTokenHash && d.pushRevision !== null);
    return { id: d.id, userId: d.userId, pushToken: d.pushToken, locale: d.locale,
      pushSessionId: d.pushSessionId, pushRevision: d.pushRevision, pushTokenHash: d.pushTokenHash };
  }
  private cascadeSession(tx: Transaction, id: string) {
    for (const d of this.devices.values()) if (d.pushSessionId === id) this.remove(tx, this.devices, d.id);
    return this.remove(tx, this.sessions, id);
  }
  private async raw(tx: Transaction, kind: "query" | "execute", parts: TemplateStringsArray, p: unknown[]) {
    const sql = normalize(parts.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, ""));
    assert(Object.values(SQL).includes(sql), `Unexpected ${kind} SQL: ${sql}`);
    const queryStatements = [SQL.userLock, SQL.create, SQL.renew, SQL.session, SQL.fence, SQL.live, SQL.duplicate,
      SQL.retireLock, SQL.current, SQL.deliverySession, SQL.deliveryFence, SQL.deliveryLive];
    assert.equal(kind, queryStatements.includes(sql) ? "query" : "execute", "raw API must match the complete statement");
    assert.equal(p.length, [...sql.matchAll(/\$(\d+)/g)].length, `exact parameter count for ${sql}`);
    assert.deepEqual(currentTenantContext(), tx.context, "transaction context must remain bound across waits");
    this.trace.push({ sql, parameters: [...p], context: { ...tx.context }, tx: tx.id });
    const result = await this.execute(tx, sql, p);
    const gate = this.gates.get(sql);
    if (gate) {
      this.gates.delete(sql);
      gate.entered.resolve();
      await gate.released.promise;
    }
    return result;
  }
  private async execute(tx: Transaction, sql: string, p: unknown[]): Promise<unknown> {
    if (sql === SQL.advisory) { await this.lock(tx, "authority-order"); return 1; }
    if (sql === SQL.userLock) {
      this.scope(tx, p[1]);
      if (!this.visible(tx, String(p[0])) || this.users.get(String(p[0])) !== p[1]) return [];
      await this.lock(tx, `user:${p[0]}`);
      return this.users.get(String(p[0])) === p[1] ? [{ id: p[0] }] : [];
    }
    if (sql === SQL.create) {
      const [id, expiresAt, userId, tenantId] = p;
      this.scope(tx, tenantId);
      assert(expiresAt instanceof Date);
      if (this.users.get(String(userId)) !== tenantId || !this.visible(tx, String(userId))) return [];
      assert(!this.sessions.has(String(id)), "session IDs cannot be recreated while present");
      this.set(tx, this.sessions, String(id), { id: String(id), userId: String(userId), tenantId: String(tenantId),
        expiresAt: expiresAt.getTime(), loginOrder: ++this.nextOrder, revision: 0, tokenHash: null });
      return [{ id }];
    }
    if (sql === SQL.renew) {
      const [expiresAt, id, userId, tenantId] = p;
      assert(expiresAt instanceof Date);
      const s = this.session(tx, id, userId, tenantId, true);
      if (!s) return [];
      await this.lock(tx, `session:${s.id}`);
      const live = this.session(tx, id, userId, tenantId, true);
      if (!live) return [];
      this.set(tx, this.sessions, live.id, { ...live, expiresAt: Math.max(live.expiresAt, expiresAt.getTime()) });
      return [{ id }];
    }
    if (sql === SQL.gcSessions || sql === SQL.gcFences) {
      assert.equal(tx.context.kind, "system", "global collection is system-scoped");
      if (sql === SQL.gcSessions) {
        const expired = [...this.sessions.values()].filter(s => s.expiresAt <= this.now).sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 100);
        return expired.reduce((count, s) => count + this.cascadeSession(tx, s.id), 0);
      }
      const collectible = [...this.fences.entries()].filter(([, f]) => ![...this.sessions.values()]
        .some(s => s.loginOrder <= f.loginOrder && s.expiresAt > this.now)).sort(([a], [b]) => a.localeCompare(b)).slice(0, 100);
      return collectible.reduce((count, [hash]) => count + this.remove(tx, this.fences, hash), 0);
    }
    if (sql === SQL.session || sql === SQL.retireLock || sql === SQL.live) {
      let s = this.session(tx, p[0], p[1], p[2], sql !== SQL.retireLock, sql === SQL.session);
      if (!s) return [];
      if (sql !== SQL.live) {
        await this.lock(tx, `session:${s.id}`);
        s = this.session(tx, p[0], p[1], p[2], sql !== SQL.retireLock, sql === SQL.session);
      }
      if (!s) return [];
      return sql === SQL.session ? [{ id: s.id, loginOrder: s.loginOrder, revision: s.revision, tokenHash: s.tokenHash }] : [{ id: s.id }];
    }
    if (sql === SQL.fenceInsert || sql === SQL.fence || sql === SQL.deliveryFence) {
      assert.match(String(p[0]), /^[a-f0-9]{64}$/);
      await this.lock(tx, `fence:${p[0]}`);
      if (sql === SQL.fenceInsert) {
        if (!this.fences.has(String(p[0]))) this.set(tx, this.fences, String(p[0]), { loginOrder: 0n, sessionId: null, revision: 0 });
        return 1;
      }
      const f = this.fences.get(String(p[0]));
      return !f ? [] : sql === SQL.fence ? [{ ...f }] : [{ token_hash: p[0] }];
    }
    if (sql === SQL.duplicate) return [...this.devices.values()].filter(d => this.visible(tx, d.userId)
      && d.userId === p[0] && d.pushSessionId === p[1] && d.pushTokenHash === p[2]
      && d.pushRevision === p[3] && d.payloadHash === p[4]).map(d => ({ id: d.id }));
    if (sql === SQL.advanceSession) {
      const s = this.session(tx, p[2], p[3], p[4], false);
      assert(s && tx.locks.has(`session:${s.id}`));
      this.set(tx, this.sessions, s.id, { ...s, revision: Number(p[0]), tokenHash: String(p[1]) });
      return 1;
    }
    if (sql === SQL.advanceFence) {
      assert(tx.locks.has(`fence:${p[3]}`));
      assert.equal(typeof p[0], "bigint");
      this.set(tx, this.fences, String(p[3]), { loginOrder: p[0] as bigint, sessionId: String(p[1]), revision: Number(p[2]) });
      return 1;
    }
    if (sql === SQL.upsert) {
      const [id, userId, token, platform, deviceName, osVersion, locale, sessionId, revision, hash, payloadHash] = p;
      assert(this.visible(tx, String(userId)));
      assert(tx.locks.has(`session:${sessionId}`) && tx.locks.has(`fence:${hash}`));
      const existing = [...this.devices.values()].find(d => d.pushTokenHash === hash && d.pushSessionId === sessionId);
      assert(!existing || existing.userId === userId);
      this.set(tx, this.devices, existing?.id ?? String(id), { id: existing?.id ?? String(id), userId: String(userId),
        pushToken: String(token), platform: String(platform), deviceName: deviceName as string | null,
        osVersion: osVersion as string | null, locale: String(locale), pushSessionId: String(sessionId),
        pushRevision: Number(revision), pushTokenHash: String(hash), payloadHash: String(payloadHash) });
      return 1;
    }
    if (sql === SQL.retire) {
      const s = this.session(tx, p[0], p[1], p[2], false);
      if (!s) return 0;
      assert(tx.locks.has(`session:${s.id}`));
      return this.cascadeSession(tx, s.id);
    }
    if (sql === SQL.locale) {
      let count = 0;
      for (const d of this.devices.values()) if (this.visible(tx, d.userId) && d.userId === p[1]
        && d.pushSessionId === p[2] && d.pushTokenHash === p[3] && d.pushRevision === p[4]) {
        this.set(tx, this.devices, d.id, { ...d, locale: String(p[0]) }); count++;
      }
      return count;
    }
    if (sql === SQL.current) return [...this.devices.values()].filter(d => d.userId === p[0] && this.current(tx, d)).map(d => this.publicDevice(d));
    if (sql === SQL.deliverySession) {
      const s = this.sessions.get(String(p[0]));
      if (!s || !this.visible(tx, s.userId)) return [];
      await this.lock(tx, `session:${p[0]}`);
      return this.sessions.has(String(p[0])) ? [{ id: p[0] }] : [];
    }
    if (sql === SQL.deliveryLive) {
      const d = this.devices.get(String(p[0]));
      return d && d.userId === p[1] && d.pushSessionId === p[2] && d.pushRevision === p[3] && this.current(tx, d) ? [{ id: d.id }] : [];
    }
    if (sql === SQL.deletePrevious || sql === SQL.legacyDelete || sql === SQL.deadDelete) {
      let count = 0;
      for (const d of this.devices.values()) {
        if (!this.visible(tx, d.userId)) continue;
        const matches = sql === SQL.deletePrevious ? d.userId === p[0] && d.pushSessionId === p[1] && d.pushTokenHash !== p[2]
          : sql === SQL.legacyDelete ? d.userId === p[0] && d.pushToken === p[1] && d.pushSessionId === null
          : d.id === p[0] && d.userId === p[1] && d.pushSessionId === p[2] && d.pushRevision === p[3];
        if (matches) count += this.remove(tx, this.devices, d.id);
      }
      return count;
    }
    throw new Error(`Unimplemented SQL: ${sql}`);
  }
}
