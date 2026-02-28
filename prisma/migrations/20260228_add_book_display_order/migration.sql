-- Add display_order column for custom book ordering (lower = higher importance)
ALTER TABLE "books" ADD COLUMN "display_order" INTEGER;

-- Index for efficient sorting
CREATE INDEX "books_display_order_idx" ON "books"("display_order");
