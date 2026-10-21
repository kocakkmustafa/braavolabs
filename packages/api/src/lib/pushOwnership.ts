import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { tenantTx } from "./db";
import { currentTenantContext } from "./tenant-context";
import { AppError } from "../middleware/error";

export interface PushActor { userId: string; tenantId: string; pushSessionId?: string }
interface Session { id: string; loginOrder: bigint; revision: number; tokenHash: string | null }
interface Fence { loginOrder: bigint; sessionId: string | null; revision: number }
export interface PushDevice {
  id: string; pushToken: string; locale: string; userId: string;
  pushSessionId: string; pushRevision: number; pushTokenHash: string;
}
type Tx = Prisma.TransactionClient;
export const tokenDigest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const changed = () => new AppError(409, "Device ownership changed");
export const pushUpgradeRequired = () => new AppError(428, "Update the app and sign in to enable push notifications");

/** Only real authentication creates authority. Device requests/refresh never insert it. */
export async function createPushSession(actor: PushActor, id: string, expiresAt: Date): Promise<boolean> {
  return tenantTx(async tx => {
    // Serialize order allocation with fence GC: no uncommitted lower-order
    // login may become visible after GC proves all older authority is gone.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1934884, 1)`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO push_sessions (id, user_id, tenant_id, expires_at)
      SELECT ${id}, id, tenant_id, ${expiresAt} FROM users
      WHERE id = ${actor.userId} AND tenant_id = ${actor.tenantId}
      RETURNING id`;
    await collectExpiredPushAuthority(tx);
    return rows.length === 1;
  });
}

/** A missing/expired/deleted session cannot be resurrected by a rotating refresh token. */
export async function renewPushSession(actor: PushActor, id: string, expiresAt: Date): Promise<boolean> {
  return tenantTx(async tx => {
    // GC must never inspect an old committed expiry while a renewal has already
    // extended it in an uncommitted transaction. Serialize BEFORE the UPDATE.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1934884, 1)`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE push_sessions SET expires_at = GREATEST(expires_at, ${expiresAt})
      WHERE id = ${id} AND user_id = ${actor.userId} AND tenant_id = ${actor.tenantId}
        AND expires_at > clock_timestamp()
      RETURNING id`;
    await collectExpiredPushAuthority(tx);
    return rows.length === 1;
  });
}

/** Bounded GC is global only in an already-declared system/auth context.
 * No fixed tombstone TTL: a fence survives while ANY older authority can live.
 * Refresh cannot renew an expired/missing row; fresh login always has a greater order.
 */
async function collectExpiredPushAuthority(tx: Tx): Promise<void> {
  if (currentTenantContext()?.kind !== "system") return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1934884, 1)`;
  await tx.$executeRaw`
    DELETE FROM push_sessions WHERE id IN (
      SELECT id FROM push_sessions WHERE expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
    )`;
  await tx.$executeRaw`
    DELETE FROM push_token_fences WHERE token_hash IN (
      SELECT f.token_hash FROM push_token_fences f
      WHERE NOT EXISTS (SELECT 1 FROM push_sessions s
        WHERE s.login_order <= f.login_order AND s.expires_at > clock_timestamp())
      ORDER BY f.token_hash LIMIT 100 FOR UPDATE OF f SKIP LOCKED
    )`;
}

async function lockSession(tx: Tx, actor: PushActor): Promise<Session> {
  if (!actor.pushSessionId) throw pushUpgradeRequired();
  const rows = await tx.$queryRaw<Session[]>`
    SELECT s.id, s.login_order AS "loginOrder", s.revision, s.token_hash AS "tokenHash"
    FROM push_sessions s JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
    WHERE s.id = ${actor.pushSessionId} AND s.user_id = ${actor.userId}
      AND s.tenant_id = ${actor.tenantId} AND s.expires_at > clock_timestamp()
    FOR UPDATE OF s`;
  if (!rows[0]) throw changed();
  return rows[0];
}

async function lockFence(tx: Tx, hash: string): Promise<Fence> {
  await tx.$executeRaw`INSERT INTO push_token_fences (token_hash) VALUES (${hash}) ON CONFLICT DO NOTHING`;
  const rows = await tx.$queryRaw<Fence[]>`
    SELECT login_order AS "loginOrder", session_id AS "sessionId", revision
    FROM push_token_fences WHERE token_hash = ${hash} FOR UPDATE`;
  if (!rows[0]) throw changed();
  return rows[0];
}

async function stillLive(tx: Tx, actor: PushActor): Promise<void> {
  // Recheck AFTER the fence wait using wall clock, not transaction-start now().
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM push_sessions WHERE id = ${actor.pushSessionId}
      AND user_id = ${actor.userId} AND tenant_id = ${actor.tenantId}
      AND expires_at > clock_timestamp()`;
  if (!rows[0]) throw changed();
}

export interface PushRegistration {
  token: string; revision: number; platform: string; locale: string;
  deviceName?: string | null; osVersion?: string | null;
}

export async function registerPushDevice(actor: PushActor, input: PushRegistration): Promise<{ success: true; revision: number }> {
  return tenantTx(async tx => {
    // User erasure locks the user then cascades into its sessions. Match that
    // order before taking a session lock and inserting a Device with a user FK.
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${actor.userId} AND tenant_id = ${actor.tenantId} FOR KEY SHARE`;
    if (!users[0]) throw changed();
    const session = await lockSession(tx, actor);
    const hash = tokenDigest(input.token);
    const fence = await lockFence(tx, hash);
    await stillLive(tx, actor);
    if (session.loginOrder < fence.loginOrder ||
        (session.loginOrder === fence.loginOrder && fence.sessionId !== session.id) ||
        input.revision < session.revision) throw changed();
    const digest = tokenDigest(JSON.stringify([
      input.token, input.platform, input.deviceName ?? null, input.osVersion ?? null, input.locale,
    ]));
    if (input.revision === session.revision) {
      const same = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM devices WHERE user_id = ${actor.userId} AND push_session_id = ${session.id}
          AND push_token_hash = ${hash} AND push_revision = ${input.revision} AND push_payload_hash = ${digest}`;
      if (session.tokenHash !== hash || fence.sessionId !== session.id || fence.revision !== input.revision || !same[0]) throw changed();
      // Exact duplicate ACK never overwrites a later locale PATCH.
      return { success: true, revision: input.revision };
    }
    await tx.$executeRaw`
      UPDATE push_sessions SET revision = ${input.revision}, token_hash = ${hash}
      WHERE id = ${session.id} AND user_id = ${actor.userId} AND tenant_id = ${actor.tenantId}`;
    await tx.$executeRaw`
      UPDATE push_token_fences SET login_order = ${session.loginOrder}, session_id = ${session.id}, revision = ${input.revision}
      WHERE token_hash = ${hash}`;
    // All Device mutations remain inside this actor's tenant/user. A's row is
    // ineligible after B advances the opaque fence; B never edits A's tenant row.
    await tx.$executeRaw`
      DELETE FROM devices WHERE user_id = ${actor.userId} AND push_session_id = ${session.id}
        AND push_token_hash <> ${hash}`;
    await tx.$executeRaw`
      INSERT INTO devices (id, user_id, push_token, platform, device_name, os_version, locale,
        push_session_id, push_revision, push_token_hash, push_payload_hash, last_seen_at, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${actor.userId}, ${input.token}, ${input.platform}, ${input.deviceName ?? null},
        ${input.osVersion ?? null}, ${input.locale}, ${session.id}, ${input.revision}, ${hash}, ${digest},
        clock_timestamp(), clock_timestamp(), clock_timestamp())
      ON CONFLICT (push_token_hash, push_session_id) DO UPDATE SET platform = EXCLUDED.platform,
        device_name = EXCLUDED.device_name, os_version = EXCLUDED.os_version, locale = EXCLUDED.locale,
        push_revision = EXCLUDED.push_revision, push_payload_hash = EXCLUDED.push_payload_hash,
        last_seen_at = clock_timestamp(), updated_at = clock_timestamp()`;
    return { success: true, revision: input.revision };
  });
}

export async function retirePushSession(actor: PushActor): Promise<void> {
  if (!actor.pushSessionId) return;
  await tenantTx(async tx => {
    await tx.$queryRaw`SELECT id FROM push_sessions WHERE id = ${actor.pushSessionId}
      AND user_id = ${actor.userId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
    // Device FK cascades; absence is permanent denial for this server-issued ID.
    await tx.$executeRaw`DELETE FROM push_sessions WHERE id = ${actor.pushSessionId}
      AND user_id = ${actor.userId} AND tenant_id = ${actor.tenantId}`;
  });
}

export async function updatePushDeviceLocale(actor: PushActor, token: string, revision: number, locale: string): Promise<boolean> {
  return tenantTx(async tx => {
    const session = await lockSession(tx, actor), hash = tokenDigest(token);
    const fence = await lockFence(tx, hash);
    await stillLive(tx, actor);
    if (session.revision !== revision || session.tokenHash !== hash || fence.sessionId !== session.id || fence.revision !== revision) return false;
    return (await tx.$executeRaw`UPDATE devices SET locale = ${locale}, updated_at = clock_timestamp()
      WHERE user_id = ${actor.userId} AND push_session_id = ${session.id}
        AND push_token_hash = ${hash} AND push_revision = ${revision}`) > 0;
  });
}

export async function unregisterLegacyPushDevice(actor: PushActor, token: string): Promise<void> {
  await tenantTx(tx => tx.$executeRaw`DELETE FROM devices WHERE user_id = ${actor.userId}
    AND push_token = ${token} AND push_session_id IS NULL`);
}

export async function currentPushDevices(userId: string): Promise<PushDevice[]> {
  return tenantTx(tx => tx.$queryRaw<PushDevice[]>`
    SELECT d.id, d.push_token AS "pushToken", d.locale, d.user_id AS "userId",
      d.push_session_id AS "pushSessionId", d.push_revision AS "pushRevision", d.push_token_hash AS "pushTokenHash"
    FROM devices d JOIN push_sessions s ON s.id = d.push_session_id AND s.user_id = d.user_id
    JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
    JOIN push_token_fences f ON f.token_hash = d.push_token_hash AND f.session_id = s.id
    WHERE d.user_id = ${userId} AND s.expires_at > clock_timestamp()
      AND s.token_hash = d.push_token_hash AND s.revision = d.push_revision AND f.revision = d.push_revision`);
}

/** Serialize provider dispatch with ownership transfer/retirement. A push already
 * handed to Expo cannot be recalled, but a snapshot cannot start a new dispatch
 * after a newer ownership transaction has completed. Lock sessions then fences
 * in stable order; callback is the existing bounded (5s) provider request.
 */
export async function withCurrentPushDelivery(
  snapshots: PushDevice[], send: (devices: PushDevice[]) => Promise<PushDevice[]>,
): Promise<void> {
  await tenantTx(async tx => {
    for (const id of [...new Set(snapshots.map(d => d.pushSessionId))].sort()) {
      await tx.$queryRaw`SELECT id FROM push_sessions WHERE id = ${id} FOR UPDATE`;
    }
    for (const hash of [...new Set(snapshots.map(d => d.pushTokenHash))].sort()) {
      await tx.$queryRaw`SELECT token_hash FROM push_token_fences WHERE token_hash = ${hash} FOR UPDATE`;
    }
    const live: PushDevice[] = [];
    for (const d of snapshots) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT d.id FROM devices d JOIN push_sessions s ON s.id = d.push_session_id AND s.user_id = d.user_id
        JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
        JOIN push_token_fences f ON f.token_hash = d.push_token_hash AND f.session_id = s.id
        WHERE d.id = ${d.id} AND d.user_id = ${d.userId} AND d.push_session_id = ${d.pushSessionId}
          AND d.push_revision = ${d.pushRevision} AND s.expires_at > clock_timestamp()
          AND s.token_hash = d.push_token_hash AND s.revision = d.push_revision AND f.revision = d.push_revision`;
      if (rows[0]) live.push(d);
    }
    if (live.length === 0) return;
    for (const d of await send(live)) {
      await tx.$executeRaw`DELETE FROM devices WHERE id = ${d.id} AND user_id = ${d.userId}
        AND push_session_id = ${d.pushSessionId} AND push_revision = ${d.pushRevision}`;
    }
  });
}
