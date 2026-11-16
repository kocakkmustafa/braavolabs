/**
 * BRA-P2-07 — hesap silinirken şirket sahipliğinin devri.
 *
 * Hesap silme hakkı (App Store / GDPR Art.17) ASLA bloke edilmez. user -> company_members FK'si
 * CASCADE olduğundan, silinen kullanıcı bir şirketin tek OWNER'ıysa şirket sessizce sahipsiz
 * kalırdı; bu yüzden aynı transaction'da (çağıran tenantTx açar, silmeyi de aynı tx'te yapar):
 *   1. silinen kullanıcının satırı FOR UPDATE kilitlenir (aday olarak seçilmesiyle serileşir),
 *   2. tek-OWNER olduğu her şirket (id sırasıyla) FOR UPDATE kilitlenir (members.ts lockCompany kalıbı),
 *   3. aday = aynı tenant'ın başka en eski OWNER/ADMIN kullanıcısı (backfill kuralı: tenant OWNER > ADMIN,
 *      created_at, id); aday satırı `FOR SHARE SKIP LOCKED` kilitlenir ve kilit sorgusu tenant + rolü yeniden
 *      doğrular: silinen, rolü artık OWNER/ADMIN olmayan ya da başka tx'in kilidindeki (zaten silinmek üzere
 *      olan; A<->B karşılıklı adaylıkta deadlock yerine) aday atlanır, sıradakine geçilir. Hepsi elenirse
 *      "aday yok" yolu: orphan log, silme bloke olmaz. (Mevcut MEMBER satırı yükseltme kararı korunur.)
 *   4. aday OWNER yapılır (varsa MEMBER satırı yükseltilir) ve activity_log'a `company.member.owner_transferred`,
 *   5. aday yoksa şirket sahipsiz kalır ve `company.owner_orphaned` yazılır.
 * activity_log yalnız kimlik (id) taşır; e-posta/ad gibi ham veri yok.
 */
const MAX_CANDIDATES = 10;

export interface OwnerTransferResult {
  transferred: number;
  orphaned: number;
}

export async function transferSoleOwnerships(
  tx: any,
  args: { tenantId: string; userId: string },
): Promise<OwnerTransferResult> {
  const { tenantId, userId } = args;
  const out: OwnerTransferResult = { transferred: 0, orphaned: 0 };

  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} AND tenant_id = ${tenantId} FOR UPDATE`;

  const owned = (await tx.companyMember.findMany({
    where: { tenantId, userId, role: "OWNER" },
    select: { companyId: true },
    orderBy: { companyId: "asc" },
  })) as Array<{ companyId: string }>;

  for (const { companyId } of owned) {
    const locked = (await tx.$queryRaw`SELECT id FROM companies WHERE id = ${companyId} AND tenant_id = ${tenantId} FOR UPDATE`) as unknown[];
    if (!locked || locked.length === 0) continue; // şirket aradan kalktı

    const otherOwners = await tx.companyMember.count({
      where: { companyId, tenantId, role: "OWNER", userId: { not: userId } },
    });
    if (otherOwners > 0) continue; // tek OWNER değil

    // Enum sırası UserRole: OWNER, ADMIN, MEMBER -> role asc = OWNER önce.
    const candidates = (await tx.user.findMany({
      where: { tenantId, id: { not: userId }, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take: MAX_CANDIDATES,
    })) as Array<{ id: string }>;

    let chosen: string | null = null;
    for (const c of candidates) {
      const row = (await tx.$queryRaw`SELECT id FROM users WHERE id = ${c.id} AND tenant_id = ${tenantId} AND role IN ('OWNER', 'ADMIN') FOR SHARE SKIP LOCKED`) as unknown[];
      if (row && row.length > 0) { chosen = c.id; break; } // silinen/kilitli/rol değişmiş aday satırı dönmez
    }

    if (chosen) {
      await tx.companyMember.upsert({
        where: { companyId_userId: { companyId, userId: chosen } },
        create: { tenantId, companyId, userId: chosen, role: "OWNER", createdById: userId },
        update: { role: "OWNER" },
      });
      await tx.activityLog.create({
        data: {
          tenantId,
          actor: "system",
          action: "company.member.owner_transferred",
          resource: "company",
          resourceId: companyId,
          details: { fromUserId: userId, toUserId: chosen, reason: "account_deletion" },
        },
      });
      out.transferred += 1;
    } else {
      await tx.activityLog.create({
        data: {
          tenantId,
          actor: "system",
          action: "company.owner_orphaned",
          resource: "company",
          resourceId: companyId,
          details: { fromUserId: userId, reason: "account_deletion_no_candidate" },
        },
      });
      out.orphaned += 1;
    }
  }
  return out;
}
