-- CreateTable
CREATE TABLE "word_translations" (
    "id" SERIAL NOT NULL,
    "surah_number" INTEGER NOT NULL,
    "ayah_number" INTEGER NOT NULL,
    "word_position" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "transliteration" TEXT,
    "source" TEXT NOT NULL DEFAULT 'quran.com',

    CONSTRAINT "word_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "word_translations_surah_number_ayah_number_word_position_lan_key" ON "word_translations"("surah_number", "ayah_number", "word_position", "language");

-- CreateIndex
CREATE INDEX "word_translations_surah_number_ayah_number_idx" ON "word_translations"("surah_number", "ayah_number");

-- CreateIndex
CREATE INDEX "word_translations_language_idx" ON "word_translations"("language");
