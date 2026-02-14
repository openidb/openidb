-- CreateTable
CREATE TABLE "quran_reciters" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name_arabic" TEXT,
    "name_english" TEXT NOT NULL,
    "style" TEXT,
    "qiraat" TEXT NOT NULL DEFAULT 'hafs',
    "bitrate" INTEGER NOT NULL DEFAULT 128,
    "total_ayahs" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "source_url" TEXT,
    "language" TEXT NOT NULL DEFAULT 'ar',
    "size_bytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "quran_reciters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quran_reciters_slug_key" ON "quran_reciters"("slug");

-- CreateIndex
CREATE INDEX "quran_reciters_qiraat_idx" ON "quran_reciters"("qiraat");

-- CreateIndex
CREATE INDEX "quran_reciters_language_idx" ON "quran_reciters"("language");
