/**
 * BRA-P2-07 — yeni şirketin oluşturanını OWNER yapar.
 *
 * Her şirket-oluşturma yolu `tx.company.create` ile AYNI transaction içinde bunu çağırır; böylece
 * şirket satırı varsa OWNER üyeliği de vardır (create başarısız olursa üyelik de yoktur) ve
 * "en az 1 OWNER" değişmezi (bkz. members.ts) şirketin ilk anından başlar.
 *
 * Oluşturan kullanıcı bilinmiyorsa (sistem/seed/script yolu) OWNER EKLENMEZ — sahipsiz şirketi
 * mevcut-şirket backfill'i (20261116400000_company_owner_backfill) ya da elle üye ekleme kapatır.
 * Çağrı idempotenttir: (companyId, userId) unique anahtarında upsert, çift satır oluşmaz.
 */
export async function seedCreatorAsOwner(
  tx: any,
  args: { tenantId: string; companyId: string; userId: string | null | undefined },
): Promise<void> {
  const { tenantId, companyId, userId } = args;
  if (!userId) return; // sistem/seed yolu: oluşturan yok → OWNER eklenmez (bilinçli)
  await tx.companyMember.upsert({
    where: { companyId_userId: { companyId, userId } },
    create: { tenantId, companyId, userId, role: "OWNER", createdById: userId },
    update: {},
  });
}
