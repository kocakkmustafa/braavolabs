/**
 * BRA-P1-06-N2 — job owner + insan onaylı teslim.
 *
 * - Owner: koşuya atanan sorumlu insan (nullable düz userId, FK yok). Atama/değiştirme:
 *   ADMIN+ ya da mevcut owner. Hedef kullanıcı aynı kiracıdan olmalı (yabancı → 404).
 * - Teslim onayı: yalnız başarılı terminal koşu (COMPLETED), yalnız bir kez, yalnız owner ya da
 *   ADMIN+. Makbuz/kanıt paketi (JobReceipt) değişmez. Kullanıcı faaliyeti İZLENMEZ.
 * - Yetki: yeni ayrık eylem YOK (rbac.ts değişmez); mevcut ROLE_RANK ile ADMIN+ kontrolü.
 * - Her where kiracıya (Pipeline → Company → tenantId) bağlıdır; yabancı kiracı 404.
 */
import { prisma, tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { ROLE_RANK, type AppRole } from "../../lib/rbac";

export interface DeliveryActor {
  tenantId: string;
  userId: string;
  role?: string;
}

const isAdminPlus = (role: string | undefined): boolean =>
  typeof role === "string" &&
  Object.prototype.hasOwnProperty.call(ROLE_RANK, role) &&
  ROLE_RANK[role as AppRole] >= ROLE_RANK.ADMIN;

const canActOnRun = (actor: DeliveryActor, ownerUserId: string | null): boolean =>
  isAdminPlus(actor.role) || (ownerUserId !== null && ownerUserId === actor.userId);

const tenantScope = (tenantId: string) => ({ pipeline: { company: { tenantId } } });

export async function assignRunOwner(
  actor: DeliveryActor,
  runId: string,
  ownerUserId: string | null,
): Promise<{ id: string; ownerUserId: string | null }> {
  const run = await prisma.run.findFirst({
    where: { id: runId, ...tenantScope(actor.tenantId) },
    select: { id: true, ownerUserId: true },
  });
  if (!run) throw new AppError(404, "Run not found");
  if (!canActOnRun(actor, run.ownerUserId)) throw new AppError(403, "Insufficient permissions");

  if (ownerUserId !== null) {
    const user = await prisma.user.findFirst({
      where: { id: ownerUserId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!user) throw new AppError(404, "User not found");
  }

  await tenantTx(async (tx) => {
    const r = await tx.run.updateMany({
      where: { id: run.id, ...tenantScope(actor.tenantId), ownerUserId: run.ownerUserId },
      data: { ownerUserId },
    });
    if (r.count === 0) throw new AppError(409, "Run changed concurrently");
    await tx.activityLog.create({
      data: {
        tenantId: actor.tenantId,
        actor: actor.userId,
        action: "run.owner.assign",
        resource: "run",
        resourceId: run.id,
        details: { previousOwnerUserId: run.ownerUserId, ownerUserId },
      },
    });
  });
  return { id: run.id, ownerUserId };
}

export async function approveRunDelivery(
  actor: DeliveryActor,
  runId: string,
): Promise<{ id: string; deliveryApprovedById: string; deliveryApprovedAt: Date }> {
  const run = await prisma.run.findFirst({
    where: { id: runId, ...tenantScope(actor.tenantId) },
    select: { id: true, status: true, state: true, ownerUserId: true, deliveryApprovedAt: true },
  });
  if (!run) throw new AppError(404, "Run not found");
  if (!canActOnRun(actor, run.ownerUserId)) throw new AppError(403, "Insufficient permissions");
  if (run.deliveryApprovedAt) throw new AppError(409, "Delivery already approved");
  if (run.status !== "COMPLETED" || (run.state != null && run.state !== "COMPLETED")) {
    throw new AppError(409, "Run is not a successfully completed run");
  }

  const at = new Date();
  await tenantTx(async (tx) => {
    // CAS: yarışta ikinci onay count 0 alır.
    const r = await tx.run.updateMany({
      where: { id: run.id, ...tenantScope(actor.tenantId), ownerUserId: run.ownerUserId, status: "COMPLETED", deliveryApprovedAt: null },
      data: { deliveryApprovedById: actor.userId, deliveryApprovedAt: at },
    });
    if (r.count === 0) throw new AppError(409, "Delivery already approved or run not completed");
    await tx.activityLog.create({
      data: {
        tenantId: actor.tenantId,
        actor: actor.userId,
        action: "run.delivery.approve",
        resource: "run",
        resourceId: run.id,
        details: { ownerUserId: run.ownerUserId },
      },
    });
  });
  return { id: run.id, deliveryApprovedById: actor.userId, deliveryApprovedAt: at };
}
