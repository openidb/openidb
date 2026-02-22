-- CreateTable
CREATE TABLE "mushaf_words" (
    "id" SERIAL NOT NULL,
    "page_number" INTEGER NOT NULL,
    "line_number" INTEGER NOT NULL,
    "position_in_line" INTEGER NOT NULL,
    "char_type_name" TEXT NOT NULL,
    "surah_number" INTEGER NOT NULL,
    "ayah_number" INTEGER NOT NULL,
    "word_position" INTEGER NOT NULL,
    "text_uthmani" TEXT NOT NULL,
    "glyph_code" TEXT NOT NULL,

    CONSTRAINT "mushaf_words_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mushaf_words_page_number_line_number_position_in_line_key" ON "mushaf_words"("page_number", "line_number", "position_in_line");

-- CreateIndex
CREATE INDEX "mushaf_words_page_number_idx" ON "mushaf_words"("page_number");

-- CreateIndex
CREATE INDEX "mushaf_words_surah_number_ayah_number_idx" ON "mushaf_words"("surah_number", "ayah_number");
