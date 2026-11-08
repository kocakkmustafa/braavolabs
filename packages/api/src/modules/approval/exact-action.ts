/**
 * BRA-P0-05 — Exact-action approval (ADR-0002).
 *
 * An approval is a one-shot grant for ONE concrete action, not a standing
 * permission for "this run". The grant is bound to:
 *   - tenant + run           (a grant cannot cross tenants or runs)
 *   - the action itself      (type, tool, canonical input, amount) via a hash
 *   - a random single-use nonce
 *   - an expiry
 * and is spent atomically (compare-and-set on `consumed_at`). A changed draft
 * hashes differently, so an old approval cannot authorise it; a replayed or
 * double-fired request finds the grant already consumed.
 *
 * Fail-closed throughout: any missing binding (no nonce, no hash, no expiry,
 * no tenant), any mismatch, an expired or already-consumed grant → rejected.
 * Legacy approvals (columns NULL) are never consumable as a grant.
 *
 * EXACT_ACTION_APPROVAL (default OFF, literal "true" only, read at call time —
 * same convention as JOB_STATE_DUAL_WRITE): while off, nothing stamps or
 * consumes grants and the SPEND gate behaves exactly as before. This module
 * has no side effects on import.
 */
import { createHash, randomBytes } from "node:crypto";

/** Only the literal string "true" enables exact-action approvals. */
export function isExactActionApprovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXACT_ACTION_APPROVAL === "true";
}

/** Bump when the hashed shape changes; old hashes then never match (fail-closed). */
export const ACTION_HASH_VERSION = 1;

/** A grant lives 24h unless the caller passes another TTL. */
export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExactAction {
  tenantId: string;
  runId: string;
  type: string;
  toolName: string;
  /** The tool input exactly as it will be executed (already tenant-scoped). */
  input: unknown;
  amountUsd: number | null;
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` object
 * members dropped (like JSON.stringify), `undefined`/functions/symbols/BigInt
 * rejected inside arrays and at the top level instead of silently becoming
 * `null`. Non-finite numbers throw: they would stringify to `null` and let two
 * different actions share a hash.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalize(v)).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof value}`);
  }
}

/** `v1:<sha256 hex>` over the canonical action. Throws on un-hashable input. */
export function computeActionHash(action: ExactAction): string {
  const body = canonicalize({
    v: ACTION_HASH_VERSION,
    tenantId: action.tenantId,
    runId: action.runId,
    type: action.type,
    toolName: action.toolName,
    input: action.input === undefined ? null : action.input,
    amountUsd: action.amountUsd,
  });
  return `v${ACTION_HASH_VERSION}:${createHash("sha256").update(body).digest("hex")}`;
}

/** 192 random bits, URL-safe. */
export function generateNonce(): string {
  return randomBytes(24).toString("base64url");
}

export interface ApprovalStamp {
  tenantId: string;
  nonce: string;
  actionHash: string;
  expiresAt: Date;
}

/** The columns to add to a new PENDING approval so it can later become a grant. */
export function buildApprovalStamp(
  action: ExactAction,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_GRANT_TTL_MS,
): ApprovalStamp {
  return {
    tenantId: action.tenantId,
    nonce: generateNonce(),
    actionHash: computeActionHash(action),
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}

export type GrantRejection =
  | "not_exact_action" // legacy row: no nonce / hash / tenant / expiry
  | "not_approved"
  | "already_consumed"
  | "tenant_mismatch"
  | "run_mismatch"
  | "hash_mismatch"
  | "expired"
  | "no_grant"; // nothing matched at all

export interface GrantRow {
  runId: string;
  tenantId: string | null;
  status: string;
  nonce: string | null;
  actionHash: string | null;
  expiresAt: Date | null;
  consumedAt: Date | null;
}

export interface ExpectedGrant {
  tenantId: string;
  runId: string;
  actionHash: string;
}

/** Pure check of one approval row against the action about to run. */
export function evaluateGrant(
  row: GrantRow,
  expected: ExpectedGrant,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: GrantRejection } {
  if (!row.nonce || !row.actionHash || !row.tenantId || !row.expiresAt) {
    return { ok: false, reason: "not_exact_action" };
  }
  if (row.tenantId !== expected.tenantId) return { ok: false, reason: "tenant_mismatch" };
  if (row.runId !== expected.runId) return { ok: false, reason: "run_mismatch" };
  if (row.status !== "APPROVED") return { ok: false, reason: "not_approved" };
  if (row.consumedAt) return { ok: false, reason: "already_consumed" };
  if (row.actionHash !== expected.actionHash) return { ok: false, reason: "hash_mismatch" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * The slice of a Prisma client (plain, extended or transaction) the consume path
 * needs — structural so the extended `prisma` export, a `tenantTx` transaction
 * and a test fake all fit. Args are loosely typed on purpose; callers build them
 * inline in this file only.
 */
export interface GrantClient {
  approval: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): PromiseLike<Array<GrantRow & { id: string }>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): PromiseLike<{ count: number }>;
  };
}

/**
 * Spend one matching grant. Reads candidate rows scoped by tenant + run +
 * action hash, re-checks each in `evaluateGrant`, then claims it with a
 * scalar compare-and-set (`id` + `nonce` + still APPROVED + not consumed), so
 * two concurrent callers can never both win the same grant. Callers run the
 * side effect only when `ok`.
 */
export async function consumeGrant(
  client: GrantClient,
  expected: ExpectedGrant,
  now: Date = new Date(),
): Promise<{ ok: true; approvalId: string } | { ok: false; reason: GrantRejection }> {
  const candidates = await client.approval.findMany({
    where: {
      runId: expected.runId,
      tenantId: expected.tenantId,
      actionHash: expected.actionHash,
      status: "APPROVED",
      consumedAt: null,
    },
    orderBy: { decidedAt: "asc" },
    take: 5,
  });

  let lastReason: GrantRejection = "no_grant";
  for (const row of candidates) {
    const verdict = evaluateGrant(row, expected, now);
    if (!verdict.ok) {
      lastReason = verdict.reason;
      continue;
    }
    // Scalar-only where: the CAS must be a single atomic UPDATE.
    const claim = await client.approval.updateMany({
      where: { id: row.id, nonce: row.nonce!, status: "APPROVED", consumedAt: null },
      data: { consumedAt: now },
    });
    if (claim.count === 1) return { ok: true, approvalId: row.id };
    lastReason = "already_consumed";
  }
  return { ok: false, reason: lastReason };
}

/** The pending approvals that must be decided before a run may go back to RUNNING. */
export const OPEN_APPROVAL_STATUS = "PENDING" as const;

/**
 * Bypass guard (BRA-P0-05, "onay atlama açığı"): `/resume`, `/handoff` →
 * `/continue` flip a run to RUNNING without anyone deciding the approval the
 * run is waiting on. True when the run still has an undecided approval —
 * fail-closed: an approval past `expiresAt` that the expiry cron has not yet
 * flipped still counts as open.
 */
export async function hasOpenApproval(
  client: {
    approval: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst(args: any): PromiseLike<{ id: string } | null>;
    };
  },
  runId: string,
): Promise<boolean> {
  const open = await client.approval.findFirst({
    where: { runId, status: OPEN_APPROVAL_STATUS },
    select: { id: true },
  });
  return open !== null;
}
