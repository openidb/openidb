-- Add line_type column to mushaf_words
ALTER TABLE "mushaf_words" ADD COLUMN IF NOT EXISTS "line_type" TEXT NOT NULL DEFAULT 'text';
