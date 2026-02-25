import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { prisma } from "../db";
import { SOURCES } from "../utils/source-urls";
import { SourceSchema } from "../schemas/common";
import { getIndexedBookIds } from "../search/elasticsearch-catalog";

const BookFeaturesQuery = z.object({
  lang: z.string().max(20).optional().openapi({ example: "en", description: "Language code for isTranslated count" }),
  categoryId: z.string().optional().openapi({ example: "5", description: "Category ID(s), comma-separated" }),
  century: z.string().optional().openapi({ example: "3,7", description: "Hijri century(ies), comma-separated" }),
});

const BookFeaturesResponse = z.object({
  features: z.object({
    hasPdf: z.number(),
    isIndexed: z.number(),
    isTranslated: z.number(),
  }),
  _sources: z.array(SourceSchema),
}).openapi("BookFeatures");

const listFeatures = createRoute({
  method: "get",
  path: "/",
  tags: ["Books"],
  summary: "Get feature filter counts for books",
  request: { query: BookFeaturesQuery },
  responses: {
    200: {
      content: { "application/json": { schema: BookFeaturesResponse } },
      description: "Counts of books matching each feature filter",
    },
  },
});

export const bookFeaturesRoutes = new OpenAPIHono();

bookFeaturesRoutes.openapi(listFeatures, async (c) => {
  const { lang, categoryId, century } = c.req.valid("query");

  // Build shared WHERE conditions for books
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (categoryId) {
    const ids = categoryId.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 1) {
      conditions.push(`b.category_id = $${paramIdx}`);
      params.push(ids[0]);
      paramIdx++;
    } else if (ids.length > 1) {
      conditions.push(`b.category_id = ANY($${paramIdx})`);
      params.push(ids);
      paramIdx++;
    }
  }

  if (century) {
    const centuries = century.split(",").map(Number).filter((n) => n >= 1 && n <= 15);
    if (centuries.length > 0) {
      conditions.push(`b.author_id IN (SELECT a.id FROM authors a WHERE a.death_century_hijri = ANY($${paramIdx}))`);
      params.push(centuries);
      paramIdx++;
    }
  }

  const whereSQL = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // All 3 counts use pre-computed columns — instant queries
  const [pdfCount, indexedCount, translatedCount] = await Promise.all([
    // hasPdf — pre-computed boolean column
    (async () => {
      const andHasPdf = conditions.length > 0 ? "AND b.has_pdf = true" : "WHERE b.has_pdf = true";
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM books b ${whereSQL} ${andHasPdf}`,
        ...params,
      );
      return Number(rows[0]?.count ?? 0);
    })(),

    // isIndexed — from Elasticsearch cached set
    (async () => {
      const indexedIds = await getIndexedBookIds();
      if (indexedIds === null || indexedIds.size === 0) return 0;

      if (conditions.length === 0) {
        return indexedIds.size;
      }

      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM books b ${whereSQL} AND b.id = ANY($${paramIdx})`,
        ...params, [...indexedIds],
      );
      return Number(rows[0]?.count ?? 0);
    })(),

    // isTranslated — pre-computed translated_languages array column
    (async () => {
      if (!lang || lang === "none" || lang === "transliteration") return 0;

      const andTranslated = conditions.length > 0
        ? `AND $${paramIdx}::text = ANY(b.translated_languages)`
        : `WHERE $${paramIdx}::text = ANY(b.translated_languages)`;
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM books b ${whereSQL} ${andTranslated}`,
        ...params, lang,
      );
      return Number(rows[0]?.count ?? 0);
    })(),
  ]);

  const result = {
    features: {
      hasPdf: pdfCount,
      isIndexed: indexedCount,
      isTranslated: translatedCount,
    },
    _sources: [...SOURCES.turath],
  };

  c.header("Cache-Control", "public, max-age=86400, stale-while-revalidate=86400");
  return c.json(result, 200);
});
