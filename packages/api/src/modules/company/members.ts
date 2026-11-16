/**
 * BRA-P1-06-N1 — şirket üyeleri (CompanyMember: OWNER | MEMBER).
 *
 * SINIR: üyelik bu dilimde BİLGİLENDİRİCİ/TEMEL bir modeldir. Mevcut hiçbir erişim
 * kontrolü (şirket/ajan/pipeline uçları) üyeliğe bakmaz; zorunlu kılma sonraki dilimdir.
 * Gözetim yok: liste yalnız kimlik/ad/e-posta/rol/oluşturma tarihi döner; faaliyet,
 * son görülme ya da kullanım alanı yoktur.
 *
 * Yetki: okuma = kimliği doğrulanmış kiracı üyesi; yazma = requirePermission("billing:budget")
 * (ADMIN+). Kurucu kararı (2026-11-15) gereği rbac.ts'e yeni eylem EKLENMEDİ; üye yönetimi için
 * ayrı bir eylem yok, bu yüzden mevcut şirket-kapsamlı ADMIN kapısı (şirket bütçe ucu) yeniden
 * kullanılır. Kapı değişirse bu uçlar da değişir — ayrık eylem gerekirse ayrı karar ister.
 *
 * Kurallar: tenantId her where'de; yabancı tenant şirket/kullanıcı 404; aynı kullanıcı iki kez
 * eklenemez (409); şirkette en az 1 OWNER kalır (son OWNER silinemez/düşürülemez, 409); her yazma
 * activity_log'a yazılır. Yazmalar tenantTx içinde, şirket satırı FOR UPDATE kilitli (eşzamanlı
 * iki "son OWNER" değişimi yarışamaz).
 */
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, tenantTx } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { requirePermission } from "../../middleware/require-permission";
import { authMiddleware } from "../../middleware/auth";

const ROLES = ["OWNER", "MEMBER"] as const;
const addSchema = z.object({ userId: z.string().min(1), role: z.enum(ROLES).default("MEMBER") }).strict();
const roleSchema = z.object({ role: z.enum(ROLES) }).strict();

export interface PublicMember {
  userId: string;
  name: string | null;
  email: string;
  role: (typeof ROLES)[number];
  createdAt: Date;
}

function toPublic(m: any): PublicMember {
  return { userId: m.userId, name: m.user?.name ?? null, email: m.user?.email, role: m.role, createdAt: m.createdAt };
}

async function lockCompany(tx: any, companyId: string, tenantId: string): Promise<void> {
  const rows = (await tx.$queryRaw`SELECT id FROM companies WHERE id = ${companyId} AND tenant_id = ${tenantId} FOR UPDATE`) as unknown[];
  if (!rows || rows.length === 0) throw new AppError(404, "Company not found");
}

async function assertNotLastOwner(tx: any, companyId: string, tenantId: string): Promise<void> {
  const owners = await tx.companyMember.count({ where: { companyId, tenantId, role: "OWNER" } });
  if (owners <= 1) throw new AppError(409, "A company must keep at least one OWNER");
}

export const companyMembersRouter = Router({ mergeParams: true });
// Üst companyRouter da authMiddleware uygular; census dosya içi işaret ister (çift doğrulama zararsız).
companyMembersRouter.use(authMiddleware);

companyMembersRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const companyId = (req.params as any).id as string;
    const company = await prisma.company.findFirst({ where: { id: companyId, tenantId }, select: { id: true } });
    if (!company) throw new AppError(404, "Company not found");
    const rows = await prisma.companyMember.findMany({
      where: { companyId, tenantId },
      orderBy: { createdAt: "asc" },
      select: { userId: true, role: true, createdAt: true, user: { select: { name: true, email: true } } },
    });
    res.json({ members: rows.map(toPublic) });
  } catch (err) { next(err); }
});

companyMembersRouter.post("/", requirePermission("billing:budget"), async (req, res, next) => {
  try {
    const body = addSchema.parse(req.body ?? {});
    const tenantId = req.auth!.tenantId;
    const companyId = (req.params as any).id as string;
    const created = await tenantTx(async (tx: any) => {
      await lockCompany(tx, companyId, tenantId);
      const user = await tx.user.findFirst({ where: { id: body.userId, tenantId }, select: { id: true, name: true, email: true } });
      if (!user) throw new AppError(404, "User not found");
      const dup = await tx.companyMember.findFirst({ where: { companyId, userId: user.id, tenantId }, select: { id: true } });
      if (dup) throw new AppError(409, "User is already a member of this company");
      const m = await tx.companyMember.create({
        data: { tenantId, companyId, userId: user.id, role: body.role, createdById: req.auth!.userId },
        select: { userId: true, role: true, createdAt: true },
      });
      await tx.activityLog.create({
        data: { tenantId, actor: req.auth!.userId, action: "company.member.add", resource: "company", resourceId: companyId, details: { userId: user.id, role: body.role } },
      });
      return { ...m, user: { name: user.name, email: user.email } };
    });
    res.status(201).json(toPublic(created));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return next(new AppError(409, "User is already a member of this company"));
    next(err);
  }
});

companyMembersRouter.patch("/:userId", requirePermission("billing:budget"), async (req, res, next) => {
  try {
    const body = roleSchema.parse(req.body ?? {});
    const tenantId = req.auth!.tenantId;
    const companyId = (req.params as any).id as string;
    const userId = req.params.userId;
    const out = await tenantTx(async (tx: any) => {
      await lockCompany(tx, companyId, tenantId);
      const m = await tx.companyMember.findFirst({
        where: { companyId, userId, tenantId },
        select: { id: true, role: true, createdAt: true, user: { select: { name: true, email: true } } },
      });
      if (!m) throw new AppError(404, "Member not found");
      if (m.role !== body.role) {
        if (m.role === "OWNER") await assertNotLastOwner(tx, companyId, tenantId);
        await tx.companyMember.updateMany({ where: { id: m.id, companyId, tenantId }, data: { role: body.role } });
        await tx.activityLog.create({
          data: { tenantId, actor: req.auth!.userId, action: "company.member.role_update", resource: "company", resourceId: companyId, details: { userId, from: m.role, to: body.role } },
        });
      }
      return { userId, role: body.role, createdAt: m.createdAt, user: m.user };
    });
    res.json(toPublic(out));
  } catch (err) { next(err); }
});

companyMembersRouter.delete("/:userId", requirePermission("billing:budget"), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId;
    const companyId = (req.params as any).id as string;
    const userId = req.params.userId;
    await tenantTx(async (tx: any) => {
      await lockCompany(tx, companyId, tenantId);
      const m = await tx.companyMember.findFirst({ where: { companyId, userId, tenantId }, select: { id: true, role: true } });
      if (!m) throw new AppError(404, "Member not found");
      if (m.role === "OWNER") await assertNotLastOwner(tx, companyId, tenantId);
      await tx.companyMember.deleteMany({ where: { id: m.id, companyId, tenantId } });
      await tx.activityLog.create({
        data: { tenantId, actor: req.auth!.userId, action: "company.member.remove", resource: "company", resourceId: companyId, details: { userId, role: m.role } },
      });
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});
