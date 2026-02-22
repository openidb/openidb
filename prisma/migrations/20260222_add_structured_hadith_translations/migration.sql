-- Add structured translation columns to hadith_translations
ALTER TABLE hadith_translations ADD COLUMN isnad_translation TEXT;
ALTER TABLE hadith_translations ADD COLUMN matn_translation TEXT;
ALTER TABLE hadith_translations ADD COLUMN footnotes_translation TEXT;
ALTER TABLE hadith_translations ADD COLUMN kitab_translation TEXT;
ALTER TABLE hadith_translations ADD COLUMN chapter_translation TEXT;
ALTER TABLE hadith_translations ADD COLUMN grade_explanation_translation TEXT;
