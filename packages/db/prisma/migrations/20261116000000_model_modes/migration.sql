-- BRA-P0-06a-2 — Model kipleri: DIRECT / CASCADE / COMPARE (kurucu kararı
-- 2026-11-15/16; docs/yula-execution/DECISIONS.md).
-- ADDITIVE ONLY: bir yeni enum, "agents" üzerinde iki nullable kolon,
-- "run_steps" üzerinde iki nullable kolon. Mevcut kolon, enum değeri ya da
-- satır anlamı değişmez; backfill YOK (NULL = kip belirtilmemiş, miras/DIRECT).
-- Geri alma = yeni kolonları yok say (hiçbir kod yolu NULL'dan farklı bir kip
-- okumadan önce ayar yazılmaz). Hiçbir ortama bu PR ile UYGULANMAZ; canlıya
-- yalnız kurucu onaylı v* ile gider.

-- CreateEnum
CREATE TYPE "ModelMode" AS ENUM ('DIRECT', 'CASCADE', 'COMPARE');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "model_mode" "ModelMode",
ADD COLUMN     "model_mode_config" JSONB;

-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN     "model_mode" "ModelMode",
ADD COLUMN     "mode_detail" JSONB;
