import crypto from "node:crypto";
import { prisma } from "../../../lib/db";

export type IapDeliveryProvider = "apple" | "google";
type DeliveryStatus = "PROCESSING" | "RETRYABLE" | "SUCCEEDED" | "POISONED";

export interface IapDeliveryIdentity {
  provider: IapDeliveryProvider;
  deliveryId: string;
  fingerprint: string;
}

interface IapDeliveryRow {
  id: string;
  provider: string;
  deliveryId: string;
  fingerprint: string;
  status: string;
  attempts: number;
  failureCode: string | null;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IapDeliveryStore {
  create(args: {
    data: {
      provider: string;
      deliveryId: string;
      fingerprint: string;
      status: DeliveryStatus;
      attempts: number;
      processingStartedAt: Date;
    };
  }): Promise<IapDeliveryRow>;
  findUnique(args: {
    where: { provider_deliveryId: { provider: string; deliveryId: string } };
  }): Promise<IapDeliveryRow | null>;
  updateMany(args: {
    where: { id: string; status?: string | { in: string[] }; attempts?: number };
    data: {
      status?: DeliveryStatus;
      attempts?: number;
      failureCode?: string | null;
      processingStartedAt?: Date | null;
      processedAt?: Date | null;
    };
  }): Promise<{ count: number }>;
}

export interface IapDeliveryResult {
  disposition: "processed" | "duplicate" | "poisoned";
  httpStatus: 200;
}

const PROCESSING_LEASE_MS = 5 * 60_000;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeCode(code: string, fallback: string): string {
  return CODE_PATTERN.test(code) ? code : fallback;
}

export class IapPoisonDeliveryError extends Error {
  readonly code: string;
  readonly httpStatus = 200 as const;

  constructor(code: string) {
    const safe = safeCode(code, "PERMANENT_PAYLOAD_REJECTED");
    super(`IAP delivery permanently rejected (${safe})`);
    this.name = "IapPoisonDeliveryError";
    this.code = safe;
  }
}

export class IapTransientDeliveryError extends Error {
  readonly code: string;
  readonly httpStatus = 503 as const;

  constructor(code: string) {
    const safe = safeCode(code, "DELIVERY_RETRY_REQUIRED");
    super(`IAP delivery retry required (${safe})`);
    this.name = "IapTransientDeliveryError";
    this.code = safe;
  }
}

/** One-way correlation only. The input must never be persisted or logged. */
export function deliveryFingerprint(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function isUniqueConflict(err: unknown): boolean {
  const value = err as { code?: string; message?: string };
  return value?.code === "P2002" || /P2002|Unique constraint/i.test(value?.message ?? "");
}

function validateIdentity(identity: IapDeliveryIdentity): void {
  if (!identity.deliveryId || identity.deliveryId.length > 256) {
    throw new IapTransientDeliveryError("DELIVERY_ID_INVALID");
  }
  if (!/^[a-f0-9]{64}$/.test(identity.fingerprint)) {
    throw new IapTransientDeliveryError("DELIVERY_FINGERPRINT_INVALID");
  }
}

async function persistStatus(
  store: IapDeliveryStore,
  row: IapDeliveryRow,
  status: DeliveryStatus,
  failureCode: string | null,
): Promise<void> {
  try {
    const changed = await store.updateMany({
      where: { id: row.id, status: "PROCESSING", attempts: row.attempts },
      data: {
        status,
        failureCode,
        processingStartedAt: null,
        processedAt: status === "SUCCEEDED" || status === "POISONED" ? new Date() : null,
      },
    });
    if (changed.count !== 1) throw new Error("delivery claim changed concurrently");
  } catch {
    throw new IapTransientDeliveryError("DELIVERY_LEDGER_UNAVAILABLE");
  }
}

async function claimDelivery(
  identity: IapDeliveryIdentity,
  store: IapDeliveryStore,
): Promise<IapDeliveryRow | IapDeliveryResult> {
  const now = new Date();
  try {
    return await store.create({
      data: {
        provider: identity.provider,
        deliveryId: identity.deliveryId,
        fingerprint: identity.fingerprint,
        status: "PROCESSING",
        attempts: 1,
        processingStartedAt: now,
      },
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw new IapTransientDeliveryError("DELIVERY_LEDGER_UNAVAILABLE");
  }

  let existing: IapDeliveryRow | null;
  try {
    existing = await store.findUnique({
      where: {
        provider_deliveryId: {
          provider: identity.provider,
          deliveryId: identity.deliveryId,
        },
      },
    });
  } catch {
    throw new IapTransientDeliveryError("DELIVERY_LEDGER_UNAVAILABLE");
  }
  if (!existing) throw new IapTransientDeliveryError("DELIVERY_LEDGER_UNAVAILABLE");
  if (existing.fingerprint !== identity.fingerprint) {
    throw new IapTransientDeliveryError("DELIVERY_ID_COLLISION");
  }
  if (existing.status === "SUCCEEDED" || existing.status === "POISONED") {
    return { disposition: "duplicate", httpStatus: 200 };
  }
  if (
    existing.status === "PROCESSING" &&
    existing.processingStartedAt &&
    now.getTime() - existing.processingStartedAt.getTime() < PROCESSING_LEASE_MS
  ) {
    throw new IapTransientDeliveryError("DELIVERY_IN_FLIGHT");
  }

  try {
    const nextAttempts = existing.attempts + 1;
    const changed = await store.updateMany({
      where: {
        id: existing.id,
        status: { in: ["RETRYABLE", "PROCESSING"] },
        attempts: existing.attempts,
      },
      data: {
        status: "PROCESSING",
        attempts: nextAttempts,
        failureCode: null,
        processingStartedAt: now,
        processedAt: null,
      },
    });
    if (changed.count !== 1) throw new Error("delivery already claimed");
    return { ...existing, status: "PROCESSING", attempts: nextAttempts, processingStartedAt: now };
  } catch {
    throw new IapTransientDeliveryError("DELIVERY_IN_FLIGHT");
  }
}

/**
 * Durable admission wrapper shared by both store webhooks. It intentionally
 * stores only normalized identifiers, a one-way fingerprint and bounded error
 * codes: never the Apple JWS, Google purchase token, OIDC token or secrets.
 */
export async function processIapDelivery(
  identity: IapDeliveryIdentity,
  effect: () => Promise<void>,
  store: IapDeliveryStore = (prisma as unknown as { iapWebhookDelivery: IapDeliveryStore })
    .iapWebhookDelivery,
  maxAttempts = 5,
): Promise<IapDeliveryResult> {
  validateIdentity(identity);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new IapTransientDeliveryError("DELIVERY_MAX_ATTEMPTS_INVALID");
  }
  const claim = await claimDelivery(identity, store);
  if (!("id" in claim)) return claim;

  try {
    await effect();
  } catch (err) {
    if (err instanceof IapPoisonDeliveryError) {
      await persistStatus(store, claim, "POISONED", err.code);
      return { disposition: "poisoned", httpStatus: 200 };
    }
    const code = err instanceof IapTransientDeliveryError ? err.code : "DELIVERY_HANDLER_FAILED";
    // `maxAttempts` bounds only local policy validation. A transient failure
    // never becomes poison/200: Pub/Sub/Apple remain responsible for their
    // external retry and DLQ policy even after our local counter is exceeded.
    // Turning exhaustion into 200 would acknowledge and permanently drop the
    // event before the external DLQ can observe it.
    await persistStatus(store, claim, "RETRYABLE", code);
    throw new IapTransientDeliveryError(code);
  }

  // The business effect completed. A failed SUCCEEDED seal is not a handler
  // failure and must never be converted into max-attempt poison/200: the
  // provider would stop redelivering even though durable completion was not
  // established. Move the claim back to RETRYABLE with a bounded redacted
  // reason and let the real source redelivery re-run the idempotent effects.
  try {
    await persistStatus(store, claim, "SUCCEEDED", null);
    return { disposition: "processed", httpStatus: 200 };
  } catch {
    await persistStatus(store, claim, "RETRYABLE", "DELIVERY_SUCCESS_UNSEALED");
    throw new IapTransientDeliveryError("DELIVERY_SUCCESS_UNSEALED");
  }
}
