/**
 * Outbound-email suppression list (opt-out must be honoured).
 *
 * One row per (tenant, normalised address). Every query carries `tenantId`
 * (CLAUDE.md rule 10). Phone numbers are deliberately NOT covered here: a
 * phone DNC model is a founder decision (see voice.service.ts placeOutboundCall).
 */
import { prisma } from "./db";

export const SUPPRESSION_REASONS = ["UNSUBSCRIBE", "BOUNCE", "COMPLAINT", "MANUAL"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function isEmailSuppressed(tenantId: string, email: string): Promise<boolean> {
  const row = await prisma.emailSuppression.findFirst({
    where: { tenantId, email: normalizeEmail(email) },
    select: { id: true },
  });
  return row !== null;
}

/** Idempotent: an existing row keeps its original reason. */
export async function suppressEmail(
  tenantId: string,
  email: string,
  reason: SuppressionReason,
): Promise<void> {
  const normalized = normalizeEmail(email);
  await prisma.emailSuppression.upsert({
    where: { tenantId_email: { tenantId, email: normalized } },
    create: { tenantId, email: normalized, reason },
    update: {},
  });
}
