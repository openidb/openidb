-- AlterTable
ALTER TABLE "ayahs" ADD COLUMN "content_hash" TEXT;

-- AlterTable
ALTER TABLE "ayah_translations" ADD COLUMN "content_hash" TEXT;

-- AlterTable
ALTER TABLE "ayah_tafsirs" ADD COLUMN "content_hash" TEXT;

-- AlterTable
ALTER TABLE "hadiths" ADD COLUMN "content_hash" TEXT;

-- AlterTable
ALTER TABLE "hadith_translations" ADD COLUMN "content_hash" TEXT;

-- AlterTable
ALTER TABLE "pages" ADD COLUMN "content_hash" TEXT;

-- AlterTable
ALTER TABLE "page_translations" ADD COLUMN "content_hash" TEXT;
