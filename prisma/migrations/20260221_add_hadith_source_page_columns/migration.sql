-- Add source book page reference columns to hadiths
ALTER TABLE "hadiths" ADD COLUMN "source_book_id" TEXT;
ALTER TABLE "hadiths" ADD COLUMN "source_page_start" INTEGER;
ALTER TABLE "hadiths" ADD COLUMN "source_page_end" INTEGER;
ALTER TABLE "hadiths" ADD COLUMN "source_volume_number" INTEGER;
ALTER TABLE "hadiths" ADD COLUMN "source_printed_page" INTEGER;
ALTER TABLE "hadiths" ADD COLUMN "kitab_arabic" TEXT;
ALTER TABLE "hadiths" ADD COLUMN "footnotes" TEXT;

-- Index for efficient lookups by source book
CREATE INDEX "hadiths_source_book_id_idx" ON "hadiths" ("source_book_id");
