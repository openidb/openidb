-- Add isnad/matn separation columns and English grade text (from hadithunlocked.com)
ALTER TABLE "hadiths" ADD COLUMN "isnad" TEXT;
ALTER TABLE "hadiths" ADD COLUMN "matn" TEXT;
ALTER TABLE "hadiths" ADD COLUMN "grade_text" TEXT;
