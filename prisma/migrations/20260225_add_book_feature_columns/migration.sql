-- Add pre-computed feature columns to books for instant filtering and counting
ALTER TABLE books ADD COLUMN has_pdf BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE books ADD COLUMN translated_languages TEXT[] NOT NULL DEFAULT '{}';

-- Partial index for hasPdf filter (only index true values since most are false)
CREATE INDEX idx_books_has_pdf ON books(has_pdf) WHERE has_pdf = true;

-- GIN index for translated_languages array containment queries
CREATE INDEX idx_books_translated_languages ON books USING GIN(translated_languages);
