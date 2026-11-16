-- BRA-P2-07 — mevcut sirketler icin idempotent OWNER backfill.
-- YALNIZ INSERT ... SELECT ... WHERE NOT EXISTS / ON CONFLICT DO UPDATE (role -> OWNER); DROP/ALTER YOK.
-- Kural: OWNER'i olmayan her sirket icin, o tenant'in en eski (created_at) tenant-OWNER/ADMIN
-- kullanicisi sirketin OWNER'i olur (tenant OWNER'lari ADMIN'den ustun oldugu icin once onlar;
-- sonra ADMIN; esitlikte en eski created_at, sonra id). Tenant'ta OWNER/ADMIN kullanici yoksa o
-- sirket ATLANIR (sahipsiz kalir; elle uye eklemeyle kapatilir).
-- Tekrar calistirmak guvenlidir (ikinci calistirmada sirkette OWNER vardir, satir uretilmez). Secilen aday
-- o sirkette zaten MEMBER ise unique cakismasi DO UPDATE ile onu OWNER yukseltir (DO NOTHING sirketi sahipsiz birakirdi). Mevcut OWNER ezilmez: WHERE NOT EXISTS OWNER filtresi zaten onlari eler.
--
-- RLS: company_members'ta tenant_rls politikasi var (current_tenant_id() IS NULL OR tenant_id = ...).
-- Migration bagli tenant olmadan (current_tenant_id() NULL => fail-open) ve superuser/tablo sahibi
-- rolle calisir; bu yuzden tum tenantlar icin tek ifadede yazabilir. Tenant baglanmis bir rolle
-- calistirilirsa yalniz o tenant'in satirlari gorunur/yazilir (yanlis tenant'a sizma olmaz).
--
-- id: Prisma @default(cuid()) uygulama tarafinda uretilir; SQL'de cuid yok. Onceki migration'larda
-- id-uretim kalibi yok (backfill INSERT'i yalniz google_purchase_aliases); PG13+ yerlesik
-- gen_random_uuid() kullanilir (TEXT sutun; format cuid olmak zorunda degil).
-- Hicbir ortama bu PR ile UYGULANMAZ; canliya yalniz `v*` surumuyle gider.
--
-- Atlananlari raporlayan SALT-OKUR sorgu (migration'dan SONRA calistir; PR aciklamasinda da var):
--   SELECT c.id, c.tenant_id, c.name FROM companies c
--   WHERE NOT EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = c.id AND m.role = 'OWNER');

INSERT INTO "company_members" ("id", "tenant_id", "company_id", "user_id", "role", "created_at")
SELECT gen_random_uuid()::text, c."tenant_id", c."id", u."id", 'OWNER'::"CompanyMemberRole", CURRENT_TIMESTAMP
FROM "companies" c
JOIN LATERAL (
  SELECT us."id"
  FROM "users" us
  WHERE us."tenant_id" = c."tenant_id" AND us."role" IN ('OWNER', 'ADMIN')
  ORDER BY (CASE us."role" WHEN 'OWNER' THEN 0 ELSE 1 END), us."created_at" ASC, us."id" ASC
  LIMIT 1
) u ON TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM "company_members" m WHERE m."company_id" = c."id" AND m."role" = 'OWNER'
)
ON CONFLICT ("company_id", "user_id") DO UPDATE SET "role" = 'OWNER'::"CompanyMemberRole";
