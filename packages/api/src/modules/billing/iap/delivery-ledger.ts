import crypto from "node:crypto";
import { z } from "zod";
import { logger } from "../../../lib/logger";
import { AppError } from "../../../middleware/error";
import type { AppendEntitlementEventInput } from "../entitlement-ledger.service";

export type IapDeliveryProvider = "apple" | "google";

export type IapDeadLetterFailureCode =
  | "invalid-payload"
  | "invalid-envelope"
  | "provider-rejected-payload"
  | "persistence-rejected";

const IAP_DEAD_LETTER_KEY = "iap:delivery:dead-letter:v1";

/**
 * A provider payload can be permanently invalid even though the delivery
 * transport itself worked. Keeping this distinct from AppError lets webhook
 * handlers acknowledge poison while still returning 5xx for outages and
 * persistence failures that the store must retry.
 */
export class PermanentIapDeliveryError extends AppError {
  constructor(
    public readonly deliveryCode: IapDeadLetterFailureCode,
    message = "IAP delivery payload is permanently invalid",
    statusCode = 400,
  ) {
    super(statusCode, message);
    this.name = "PermanentIapDeliveryError";
  }
}

export function isPermanentIapDeliveryError(error: unknown): error is PermanentIapDeliveryError {
  return error instanceof PermanentIapDeliveryError;
}

const serializedEntitlementSchema = z.object({
  tenantId: z.string().min(1).max(200),
  source: z.enum(["stripe", "apple", "google"]),
  streamId: z.string().min(1).max(500),
  sourceEventId: z.string().min(1).max(500),
  sourceTimestamp: z.string().datetime(),
  type: z.enum(["purchase", "renewal", "cancel", "grace", "refund", "revoke", "restore"]),
  planTier: z.string().max(100).nullable(),
  expiresAt: z.string().datetime().nullable(),
  autoRenew: z.boolean(),
});

const deadLetterSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(200),
  provider: z.enum(["apple", "google"]),
  failureCode: z.enum([
    "invalid-payload",
    "invalid-envelope",
    "provider-rejected-payload",
    "persistence-rejected",
  ]),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  deliveryIdSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recordedAt: z.string().datetime(),
  entitlementEvent: serializedEntitlementSchema.nullable(),
});

export type IapDeadLetterRecord = z.infer<typeof deadLetterSchema>;

export interface AppendIapDeadLetterInput {
  provider: IapDeliveryProvider;
  failureCode: IapDeadLetterFailureCode;
  /** Sensitive provider material. It is hashed in-memory and never persisted. */
  rawPayload: string;
  deliveryId?: string;
  /** Optional normalized, secret-free reducer input for operator replay. */
  entitlementEvent?: AppendEntitlementEventInput;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function serializeEntitlement(input: AppendEntitlementEventInput) {
  return {
    ...input,
    sourceTimestamp: input.sourceTimestamp.toISOString(),
    expiresAt: input.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Append a redacted dead-letter record. HSETNX makes repeat poison deliveries
 * converge on the first immutable record. No receipt, token, JWS, provider
 * response body, or secret is written to Redis or logger fields.
 */
export async function appendIapDeadLetter(
  input: AppendIapDeadLetterInput,
): Promise<IapDeadLetterRecord> {
  const { redis } = await import("../../../lib/redis");
  const payloadSha256 = sha256(input.rawPayload);
  const deliveryIdSha256 = input.deliveryId ? sha256(input.deliveryId) : null;
  const id = `${input.provider}:${sha256(
    `${input.provider}:${input.failureCode}:${payloadSha256}:${deliveryIdSha256 ?? "none"}`,
  )}`;
  const record = deadLetterSchema.parse({
    version: 1,
    id,
    provider: input.provider,
    failureCode: input.failureCode,
    payloadSha256,
    deliveryIdSha256,
    recordedAt: new Date().toISOString(),
    entitlementEvent: input.entitlementEvent
      ? serializeEntitlement(input.entitlementEvent)
      : null,
  });

  await redis.hsetnx(IAP_DEAD_LETTER_KEY, record.id, JSON.stringify(record));
  logger.warn(
    {
      provider: record.provider,
      failureCode: record.failureCode,
      deadLetterId: record.id,
      payloadSha256: record.payloadSha256,
    },
    "IAP delivery dead-lettered",
  );
  return record;
}

export type IapDeadLetterReplayResult =
  | { status: "missing" }
  | { status: "not-replayable" }
  | { status: "replayed" };

/**
 * Replay never removes or mutates the DLQ record. When normalized reducer
 * input is present, the same recordEntitlementEvent path used by live webhook
 * traffic provides unique-key dedup and full-history reprojection.
 */
export async function replayIapDeadLetter(
  recordId: string,
  apply?: (event: AppendEntitlementEventInput) => Promise<unknown>,
): Promise<IapDeadLetterReplayResult> {
  const { redis } = await import("../../../lib/redis");
  const raw = await redis.hget(IAP_DEAD_LETTER_KEY, recordId);
  if (!raw) return { status: "missing" };

  let record: IapDeadLetterRecord;
  try {
    record = deadLetterSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppError(500, "IAP dead-letter record failed validation");
  }
  if (!record.entitlementEvent) return { status: "not-replayable" };

  const applyEntitlement = apply
    ?? (await import("../entitlement-ledger.service")).recordEntitlementEvent;
  await applyEntitlement({
    ...record.entitlementEvent,
    sourceTimestamp: new Date(record.entitlementEvent.sourceTimestamp),
    expiresAt: record.entitlementEvent.expiresAt
      ? new Date(record.entitlementEvent.expiresAt)
      : null,
  });
  logger.info(
    { provider: record.provider, deadLetterId: record.id },
    "IAP dead-letter replay completed",
  );
  return { status: "replayed" };
}
