-- Enable pg_trgm extension for trigram-based text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for author name search (ILIKE '%term%')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authors_name_arabic_trgm ON authors USING GIN (name_arabic gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authors_name_latin_trgm ON authors USING GIN (name_latin gin_trgm_ops);

-- GIN trigram indexes for book title search (ILIKE '%term%')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_books_title_arabic_trgm ON books USING GIN (title_arabic gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_books_title_latin_trgm ON books USING GIN (title_latin gin_trgm_ops);
