-- AlterTable
ALTER TABLE "hadiths" ADD COLUMN "dorar_id" TEXT,
ADD COLUMN "narrator_name" TEXT,
ADD COLUMN "grade" TEXT,
ADD COLUMN "grade_explanation" TEXT,
ADD COLUMN "grader_name" TEXT,
ADD COLUMN "grader_dorar_id" INTEGER,
ADD COLUMN "source_book_name" TEXT,
ADD COLUMN "source_book_dorar_id" INTEGER,
ADD COLUMN "number_or_page" TEXT,
ADD COLUMN "takhrij" TEXT,
ADD COLUMN "categories" JSONB,
ADD COLUMN "has_similar" BOOLEAN DEFAULT false,
ADD COLUMN "has_alternate" BOOLEAN DEFAULT false,
ADD COLUMN "has_usul" BOOLEAN DEFAULT false,
ADD COLUMN "sharh_text" TEXT,
ADD COLUMN "usul_data" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "hadiths_dorar_id_key" ON "hadiths"("dorar_id");

-- CreateIndex
CREATE INDEX "hadiths_dorar_id_idx" ON "hadiths"("dorar_id");
