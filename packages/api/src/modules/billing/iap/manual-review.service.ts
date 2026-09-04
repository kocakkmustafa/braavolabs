import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/db";
import { AppError } from "../../../middleware/error";
import { iapCredentialDigest } from "../entitlement-mapping";
import type { InternalPaidPlan, MobilePublicTier } from "./catalog";

export type ManualReviewState = "pending" | "approved_mapping" | "rejected" | "expired";

export interface ManualReviewCase {
  caseId: string;
  tenantId: string;
  provider: "apple" | "google";
  productId: string;
  internalPlan: InternalPaidPlan;
  subscriptionId: string;
  identityRef: string;
  state: ManualReviewState;
  targetTier: MobilePublicTier | null;
  reason: string | null;
  providerStatus: string | null;
  expiresAt: string | null;
  autoRenew: boolean | null;
}

type ActivityRow = {
  id: string;
  tenantId: string;
  action: string;
  resource: string;
  resourceId: string | null;
  details: unknown;
  createdAt: Date;
};

export interface ManualReviewStore {
  activityLog: {
    upsert(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<ActivityRow[]>;
    create(args: unknown): Promise<unknown>;
  };
}

const RESOURCE = "iap_manual_review";
const STATE_ACTION_PREFIX = "billing.iap.manual_review";
const PENDING_ACTION = `${STATE_ACTION_PREFIX}.pending`;
const TERMINAL_ACTIONS = new Set([
  `${STATE_ACTION_PREFIX}.approved_mapping`,
  `${STATE_ACTION_PREFIX}.rejected`,
  `${STATE_ACTION_PREFIX}.expired`,
]);

const HUMAN_REVIEW_NOTE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,;:!?()'’/-]*$/u;
const LABELLED_CREDENTIAL_VALUE =
  /["']?(?:receipt|purchase[_-]?token|original[_-]?transaction[_-]?id|private[_-]?key|service[_-]?account|client[_-]?secret)["']?\s*[:=]\s*([^\s,;.!?]+)/gi;
const JWT_LIKE =
  /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
const LONG_OPAQUE_FRAGMENT = /[A-Za-z0-9+/_=-]{24,}/;
const LONG_NUMERIC_IDENTIFIER = /(?:^|\D)\d{10,}(?:\D|$)/;
const OPAQUE_PUNCTUATED_SINGLE_TOKEN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/;
const ANY_PEM_BLOCK = /-----BEGIN [A-Z0-9][A-Z0-9 -]*-----/i;

function digest(domain: string, ...parts: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isState(value: unknown): value is ManualReviewState {
  return value === "pending" || value === "approved_mapping" || value === "rejected" || value === "expired";
}

function isTier(value: unknown): value is MobilePublicTier {
  return value === "INDIVIDUAL" || value === "TEAM";
}

function isInternalPlan(value: unknown): value is InternalPaidPlan {
  return value === "CREATOR" || value === "PRO" || value === "BUSINESS" || value === "ENTERPRISE";
}

function isUniqueConflict(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === "P2002" || /P2002|Unique constraint/i.test(value?.message ?? "");
}

function looksOpaqueLabelValue(value: string): boolean {
  if (value.length >= 20) return true;
  if (value.length >= 8 && /[-_+/=]/.test(value)) return true;
  if (value.length >= 10 && /[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return /^\d{10,}$/.test(value);
}

function hasLabelledCredentialValue(reason: string): boolean {
  for (const match of reason.matchAll(LABELLED_CREDENTIAL_VALUE)) {
    if (looksOpaqueLabelValue(match[1] ?? "")) return true;
  }
  return false;
}

export function validateManualReviewReason(
  input: string,
  forbiddenExact: readonly string[] = [],
): string {
  const reason = input.trim();
  const containsForbiddenValue = forbiddenExact.some(
    (value) => value.length > 0 && reason.includes(value),
  );
  if (reason.length < 1 || reason.length > 500) {
    throw new AppError(400, "Manual review reason must be between 1 and 500 characters");
  }
  if (
    containsForbiddenValue
    || !HUMAN_REVIEW_NOTE.test(reason)
    || hasLabelledCredentialValue(reason)
    || JWT_LIKE.test(reason)
    || LONG_OPAQUE_FRAGMENT.test(reason)
    || LONG_NUMERIC_IDENTIFIER.test(reason)
    || (reason.length >= 16 && OPAQUE_PUNCTUATED_SINGLE_TOKEN.test(reason))
    || ANY_PEM_BLOCK.test(reason)
  ) {
    throw new AppError(400, "Manual review reason must be a plain human note without credential material");
  }
  return reason;
}

export function manualReviewCaseId(input: {
  tenantId: string;
  provider: "apple" | "google";
  productId: string;
  providerIdentity: string;
}): string {
  return `iap_review_${digest(
    "braavo:iap:manual-review-case:v1",
    input.tenantId,
    input.provider,
    input.productId,
    input.providerIdentity,
  )}`;
}

export async function getManualReviewCase(
  tenantId: string,
  caseId: string,
  store: ManualReviewStore = prisma as unknown as ManualReviewStore,
): Promise<ManualReviewCase | null> {
  const rows = await store.activityLog.findMany({
    where: {
      tenantId,
      resource: RESOURCE,
      resourceId: caseId,
      action: { startsWith: `${STATE_ACTION_PREFIX}.` },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const pending = rows.find((row) => asObject(row.details)?.state === "pending");
  const details = pending ? asObject(pending.details) : null;
  if (!pending || !details) return null;
  if (
    (details.provider !== "apple" && details.provider !== "google")
    || typeof details.productId !== "string"
    || !isInternalPlan(details.internalPlan)
    || typeof details.subscriptionId !== "string"
    || typeof details.identityRef !== "string"
  ) {
    throw new AppError(500, "Manual review case is malformed");
  }

  let state: ManualReviewState = "pending";
  let targetTier: MobilePublicTier | null = null;
  let reason: string | null = null;
  let providerStatus = typeof details.providerStatus === "string" ? details.providerStatus : null;
  let expiresAt = typeof details.expiresAt === "string" ? details.expiresAt : null;
  let autoRenew = typeof details.autoRenew === "boolean" ? details.autoRenew : null;
  for (const row of rows) {
    const event = asObject(row.details);
    if (!event) continue;
    if (event.kind === "provider_state") {
      providerStatus = typeof event.providerStatus === "string" ? event.providerStatus : providerStatus;
      expiresAt = typeof event.expiresAt === "string" ? event.expiresAt : expiresAt;
      autoRenew = typeof event.autoRenew === "boolean" ? event.autoRenew : autoRenew;
      continue;
    }
    if (isState(event.state) && event.state !== "pending" && state === "pending") {
      state = event.state;
      targetTier = isTier(event.targetTier) ? event.targetTier : null;
      reason = typeof event.reason === "string" ? event.reason : null;
    }
  }

  return {
    caseId,
    tenantId,
    provider: details.provider,
    productId: details.productId,
    internalPlan: details.internalPlan,
    subscriptionId: details.subscriptionId,
    identityRef: details.identityRef,
    state,
    targetTier,
    reason,
    providerStatus,
    expiresAt,
    autoRenew,
  };
}

/**
 * Tenant-scoped visibility for pending reviews. Review cases deliberately live
 * in the append-only ActivityLog rather than the entitlement ledger, so this
 * query must remain separate from paid-tier projection. Any storage or
 * malformed-pending failure propagates: hiding a review would be a fail-open.
 */
export async function hasPendingManualReviewCases(
  tenantId: string,
  store: ManualReviewStore = prisma as unknown as ManualReviewStore,
): Promise<boolean> {
  const rows = await store.activityLog.findMany({
    where: {
      tenantId,
      resource: RESOURCE,
      action: { startsWith: `${STATE_ACTION_PREFIX}.` },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const pending = new Set<string>();
  const terminal = new Set<string>();
  for (const row of rows) {
    if (row.action !== PENDING_ACTION && !TERMINAL_ACTIONS.has(row.action)) continue;
    if (!row.resourceId) {
      throw new AppError(500, "Manual review visibility record is malformed");
    }
    if (row.action === PENDING_ACTION) pending.add(row.resourceId);
    else terminal.add(row.resourceId);
  }
  return [...pending].some((caseId) => !terminal.has(caseId));
}

export async function ensureManualReviewCase(input: {
  tenantId: string;
  actor: string;
  provider: "apple" | "google";
  productId: string;
  internalPlan: InternalPaidPlan;
  subscriptionId: string;
  providerIdentity: string;
  providerStatus?: string;
  expiresAt?: Date;
  autoRenew?: boolean;
}, store: ManualReviewStore = prisma as unknown as ManualReviewStore): Promise<ManualReviewCase> {
  const caseId = manualReviewCaseId(input);
  const identityRef = iapCredentialDigest(input.provider, input.providerIdentity);
  const pendingEventId = `iap_review_pending_${digest("braavo:iap:manual-review-pending:v1", caseId)}`;
  const pendingDetails = {
    schemaVersion: 1,
    state: "pending",
    provider: input.provider,
    productId: input.productId,
    internalPlan: input.internalPlan,
    subscriptionId: input.subscriptionId,
    identityRef,
    providerStatus: input.providerStatus ?? null,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    autoRenew: input.autoRenew ?? null,
  } satisfies Prisma.InputJsonObject;

  await store.activityLog.upsert({
    where: { id: pendingEventId },
    create: {
      id: pendingEventId,
      tenantId: input.tenantId,
      actor: input.actor,
      action: `${STATE_ACTION_PREFIX}.pending`,
      resource: RESOURCE,
      resourceId: caseId,
      details: pendingDetails,
    },
    update: {},
  });

  if (input.providerStatus && input.expiresAt && input.autoRenew !== undefined) {
    const providerStateId = `iap_review_provider_${digest(
      "braavo:iap:manual-review-provider-state:v1",
      caseId,
      input.providerStatus,
      input.expiresAt.toISOString(),
      String(input.autoRenew),
    )}`;
    await store.activityLog.upsert({
      where: { id: providerStateId },
      create: {
        id: providerStateId,
        tenantId: input.tenantId,
        actor: input.actor,
        action: `${STATE_ACTION_PREFIX}.provider_state`,
        resource: RESOURCE,
        resourceId: caseId,
        details: {
          schemaVersion: 1,
          kind: "provider_state",
          providerStatus: input.providerStatus,
          expiresAt: input.expiresAt.toISOString(),
          autoRenew: input.autoRenew,
        } satisfies Prisma.InputJsonObject,
      },
      update: {},
    });
  }

  return await getManualReviewCase(input.tenantId, caseId, store) ?? {
    caseId,
    tenantId: input.tenantId,
    provider: input.provider,
    productId: input.productId,
    internalPlan: input.internalPlan,
    subscriptionId: input.subscriptionId,
    identityRef,
    state: "pending",
    targetTier: null,
    reason: null,
    providerStatus: input.providerStatus ?? null,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    autoRenew: input.autoRenew ?? null,
  };
}

export async function transitionManualReviewCase(input: {
  tenantId: string;
  actor: string;
  caseId: string;
  state: Exclude<ManualReviewState, "pending">;
  targetTier?: MobilePublicTier;
  reason: string;
}, store: ManualReviewStore = prisma as unknown as ManualReviewStore): Promise<ManualReviewCase> {
  const reason = validateManualReviewReason(input.reason);
  if (input.state === "approved_mapping" && !input.targetTier) {
    throw new AppError(400, "Approved mapping requires a target tier");
  }
  if (input.state !== "approved_mapping" && input.targetTier !== undefined) {
    throw new AppError(400, "Only an approved mapping may include a target tier");
  }

  const current = await getManualReviewCase(input.tenantId, input.caseId, store);
  if (!current) throw new AppError(404, "Manual review case not found");
  if (current.state !== "pending") {
    const replayTarget = input.state === "approved_mapping" ? input.targetTier! : null;
    if (
      current.state === input.state
      && current.targetTier === replayTarget
      && current.reason === reason
    ) return current;
    throw new AppError(409, "Manual review case already has a terminal decision");
  }

  const decisionId = `iap_review_decision_${digest("braavo:iap:manual-review-decision:v1", input.caseId)}`;
  const details = {
    schemaVersion: 1,
    state: input.state,
    targetTier: input.state === "approved_mapping" ? input.targetTier! : null,
    reason,
  } satisfies Prisma.InputJsonObject;

  try {
    await store.activityLog.create({
      data: {
        id: decisionId,
        tenantId: input.tenantId,
        actor: input.actor,
        action: `${STATE_ACTION_PREFIX}.${input.state}`,
        resource: RESOURCE,
        resourceId: input.caseId,
        details,
      },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const decided = await getManualReviewCase(input.tenantId, input.caseId, store);
    if (
      decided?.state === input.state
      && decided.targetTier === (input.state === "approved_mapping" ? input.targetTier! : null)
      && decided.reason === reason
    ) return decided;
    throw new AppError(409, "Manual review case already has a terminal decision");
  }

  return { ...current, state: input.state, targetTier: input.state === "approved_mapping" ? input.targetTier! : null, reason };
}
