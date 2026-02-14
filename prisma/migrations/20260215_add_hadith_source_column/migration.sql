-- Add source column to track data provenance for each hadith
ALTER TABLE "hadiths" ADD COLUMN "source" TEXT;

-- Backfill existing data
-- Sunnah.com collections
UPDATE "hadiths" SET "source" = 'sunnah.com'
WHERE "book_id" IN (
  SELECT hb.id FROM "hadith_books" hb
  JOIN "hadith_collections" hc ON hb.collection_id = hc.id
  WHERE hc.slug IN (
    'bukhari', 'muslim', 'abudawud', 'tirmidhi', 'nasai', 'ibnmajah',
    'ahmad', 'malik', 'darimi', 'riyadussalihin', 'adab', 'shamail',
    'mishkat', 'bulugh', 'nawawi40', 'qudsi40', 'hisn'
  )
);

-- HadithUnlocked.com collections
UPDATE "hadiths" SET "source" = 'hadithunlocked.com'
WHERE "book_id" IN (
  SELECT hb.id FROM "hadith_books" hb
  JOIN "hadith_collections" hc ON hb.collection_id = hc.id
  WHERE hc.slug IN (
    'mustadrak', 'ibn-hibban', 'mujam-kabir', 'sunan-kubra-bayhaqi',
    'sunan-kubra-nasai', 'suyuti', 'ahmad-zuhd'
  )
);
