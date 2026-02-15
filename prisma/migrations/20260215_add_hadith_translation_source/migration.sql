-- Add source and model columns to hadith_translations
ALTER TABLE hadith_translations ADD COLUMN source TEXT;
ALTER TABLE hadith_translations ADD COLUMN model TEXT;

-- Backfill source from the hadiths table provenance
UPDATE hadith_translations ht
SET source = h.source
FROM hadiths h
WHERE ht.book_id = h.book_id
  AND ht.hadith_number = h.hadith_number
  AND ht.source IS NULL
  AND h.source IS NOT NULL;

-- Any remaining NULL sources default to sunnah.com (pre-hadithunlocked imports)
UPDATE hadith_translations SET source = 'sunnah.com' WHERE source IS NULL;
