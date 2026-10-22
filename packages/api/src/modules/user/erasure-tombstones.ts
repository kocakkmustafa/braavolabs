/**
 * Erasure tombstones — re-apply account deletions after a database restore.
 *
 * Retention profile (short): product data is erased immediately on account
 * deletion, backups rotate every 30 days, and a restore must not bring erased
 * accounts back. Each erasure therefore leaves a tombstone holding only the
 * SHA-256 of the erased row id (no email, name or content):
 *
 *   - in the `erasure_tombstones` table, and
 *   - optionally, appended to a JSONL ledger at ERASURE_LEDGER_PATH. The
 *     ledger must live outside the database backup (separate volume/bucket):
 *     a restore rolls the table back to the backup point, so tombstones written
 *     after that backup survive only in the ledger.
 *
 * After a restore, `reapplyErasures` (scripts/reapply-erasures.ts) merges the
 * ledger into the table, deletes every tenant/user whose id hash has a
 * tombstone (cascades remove their dependent rows), and purges tombstones
 * past their expiry. Tombstones expire after the backup rotation plus margin;
 * by then no backup can still contain the erased rows.
 */
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { tenantTx } from "../../lib/db";
import { runWithoutTenant } from "../../lib/tenant-context";

export const TOMBSTONE_RETENTION_DAYS = 37; // 30-day backup rotation + 7-day margin
const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type ErasureSubjectKind = "user" | "tenant";
export interface ErasureSubject { kind: ErasureSubjectKind; id: string }
export interface Tombstone { kind: ErasureSubjectKind; hash: string; erasedAt: Date; expiresAt: Date }

/** Same value as PostgreSQL `encode(sha256(convert_to(id, 'UTF8')), 'hex')`. */
export function subjectHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

export function tombstonesFor(subjects: ErasureSubject[], now: Date): Tombstone[] {
  const expiresAt = new Date(now.getTime() + TOMBSTONE_RETENTION_DAYS * DAY_MS);
  return subjects.map(({ kind, id }) => {
    if (!id) throw new Error("Erasure subject id is required");
    return { kind, hash: subjectHash(id), erasedAt: now, expiresAt };
  });
}

/**
 * Persist tombstones (idempotent) and append them to the external ledger when
 * configured. Call BEFORE deleting the rows: if the deletion then fails, the
 * tombstone only re-applies an erasure the account holder already requested.
 */
export async function recordErasureTombstones(
  subjects: ErasureSubject[],
  options: { now?: Date; ledgerPath?: string } = {},
): Promise<Tombstone[]> {
  const tombstones = tombstonesFor(subjects, options.now ?? new Date());
  await tenantTx(async (tx) => {
    for (const t of tombstones) {
      await tx.$executeRaw`INSERT INTO erasure_tombstones (subject_kind, subject_hash, erased_at, expires_at)
        VALUES (${t.kind}, ${t.hash}, ${t.erasedAt}, ${t.expiresAt})
        ON CONFLICT (subject_kind, subject_hash)
        DO UPDATE SET expires_at = GREATEST(erasure_tombstones.expires_at, EXCLUDED.expires_at)`;
    }
  });
  if (options.ledgerPath) {
    const lines = tombstones.map((t) => JSON.stringify({ kind: t.kind, hash: t.hash,
      erasedAt: t.erasedAt.toISOString(), expiresAt: t.expiresAt.toISOString() }) + "\n").join("");
    await appendFile(options.ledgerPath, lines, { mode: 0o600 });
  }
  return tombstones;
}

/** Parse ledger JSONL strictly; any malformed line rejects the whole ledger. */
export function parseLedger(text: string): Tombstone[] {
  const out: Tombstone[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error(`Erasure ledger line ${index + 1} is not JSON`); }
    const r = row as Record<string, unknown>;
    const erasedAt = new Date(String(r.erasedAt)), expiresAt = new Date(String(r.expiresAt));
    if ((r.kind !== "user" && r.kind !== "tenant") || typeof r.hash !== "string" || !HASH_PATTERN.test(r.hash) ||
        Number.isNaN(erasedAt.getTime()) || Number.isNaN(expiresAt.getTime()) || expiresAt < erasedAt) {
      throw new Error(`Erasure ledger line ${index + 1} is invalid`);
    }
    out.push({ kind: r.kind, hash: r.hash, erasedAt, expiresAt });
  });
  return out;
}

export interface ReapplyResult { ledgerMerged: number; tenantsDeleted: number; usersDeleted: number; tombstonesPurged: number }

/**
 * Restore-time re-application. Runs as an explicit all-tenant maintenance
 * path in one transaction: merge ledger tombstones, delete matching tenants
 * (cascade) and users, then purge expired tombstones. Idempotent.
 */
export async function reapplyErasures(options: { ledger?: Tombstone[]; now?: Date } = {}): Promise<ReapplyResult> {
  const now = options.now ?? new Date();
  const ledger = options.ledger ?? [];
  return runWithoutTenant("maintenance:erasure-reapply", () => tenantTx(async (tx) => {
    for (const t of ledger) {
      await tx.$executeRaw`INSERT INTO erasure_tombstones (subject_kind, subject_hash, erased_at, expires_at)
        VALUES (${t.kind}, ${t.hash}, ${t.erasedAt}, ${t.expiresAt})
        ON CONFLICT (subject_kind, subject_hash)
        DO UPDATE SET expires_at = GREATEST(erasure_tombstones.expires_at, EXCLUDED.expires_at)`;
    }
    const tenantsDeleted = await tx.$executeRaw`DELETE FROM tenants t USING erasure_tombstones e
      WHERE e.subject_kind = 'tenant' AND e.subject_hash = encode(sha256(convert_to(t.id, 'UTF8')), 'hex')`;
    const usersDeleted = await tx.$executeRaw`DELETE FROM users u USING erasure_tombstones e
      WHERE e.subject_kind = 'user' AND e.subject_hash = encode(sha256(convert_to(u.id, 'UTF8')), 'hex')`;
    const tombstonesPurged = await tx.$executeRaw`DELETE FROM erasure_tombstones WHERE expires_at < ${now}`;
    return { ledgerMerged: ledger.length, tenantsDeleted, usersDeleted, tombstonesPurged };
  }, { timeout: 120_000 }));
}
