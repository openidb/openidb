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
  hasPdf: z.enum(["true"]).optional().openapi({ description: "Base filter: only books with PDFs" }),
  isIndexed: z.enum(["true"]).optional().openapi({ description: "Base filter: only indexed books" }),
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
  const { lang, categoryId, century, hasPdf, isIndexed } = c.req.valid("query");

  // Build shared WHERE conditions (category + century + feature base filters)
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

  // Feature cross-filters: each feature count excludes itself but includes the others
  const featureBaseConditions: string[] = [];
  let indexedIds: Set<string> | null = null;
  if (hasPdf === "true") {
    featureBaseConditions.push("hasPdf");
  }
  if (isIndexed === "true") {
    indexedIds = await getIndexedBookIds();
    if (indexedIds === null || indexedIds.size === 0) {
      // No indexed books — all counts are 0
      return c.json({
        features: { hasPdf: 0, isIndexed: 0, isTranslated: 0 },
        _sources: [...SOURCES.turath],
      }, 200);
    }
    featureBaseConditions.push("isIndexed");
  }

  // Helper: build WHERE clause with base conditions + optional extra feature conditions
  function buildWhere(extraConditions: string[], extraParams: unknown[]): { sql: string; allParams: unknown[] } {
    const all = [...conditions, ...extraConditions];
    const allP = [...params, ...extraParams];
    return {
      sql: all.length > 0 ? `WHERE ${all.join(" AND ")}` : "",
      allParams: allP,
    };
  }

  // All 3 counts use pre-computed columns — each count applies OTHER feature filters as base
  const [pdfCount, indexedCount, translatedCount] = await Promise.all([
    // hasPdf — apply isIndexed as base (but NOT hasPdf itself)
    (async () => {
      const extra: string[] = [];
      const extraP: unknown[] = [];
      if (isIndexed === "true" && indexedIds) {
        extra.push(`b.id = ANY($${paramIdx + extra.length})`);
        extraP.push([...indexedIds]);
      }
      const { sql, allParams } = buildWhere(extra, extraP);
      const andHasPdf = sql ? "AND b.has_pdf = true" : "WHERE b.has_pdf = true";
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM books b ${sql} ${andHasPdf}`,
        ...allParams,
      );
      return Number(rows[0]?.count ?? 0);
    })(),

    // isIndexed — apply hasPdf as base (but NOT isIndexed itself)
    (async () => {
      const allIndexedIds = indexedIds ?? await getIndexedBookIds();
      if (allIndexedIds === null || allIndexedIds.size === 0) return 0;

      const extra: string[] = [];
      const extraP: unknown[] = [];
      if (hasPdf === "true") {
        extra.push("b.has_pdf = true");
      }
      const { sql, allParams } = buildWhere(extra, extraP);
      const andIndexed = sql
        ? `AND b.id = ANY($${params.length + extraP.length + 1})`
        : `WHERE b.id = ANY($${params.length + extraP.length + 1})`;
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM books b ${sql} ${andIndexed}`,
        ...allParams, [...allIndexedIds],
      );
      return Number(rows[0]?.count ?? 0);
    })(),

    // isTranslated — apply hasPdf + isIndexed as base
    (async () => {
      if (!lang || lang === "none" || lang === "transliteration") return 0;

      const extra: string[] = [];
      const extraP: unknown[] = [];
      if (hasPdf === "true") {
        extra.push("b.has_pdf = true");
      }
      if (isIndexed === "true" && indexedIds) {
        extra.push(`b.id = ANY($${params.length + extraP.length + 1})`);
        extraP.push([...indexedIds]);
      }
      const { sql, allParams } = buildWhere(extra, extraP);
      const andTranslated = sql
        ? `AND $${allParams.length + 1}::text = ANY(b.translated_languages)`
        : `WHERE $${allParams.length + 1}::text = ANY(b.translated_languages)`;
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM books b ${sql} ${andTranslated}`,
        ...allParams, lang,
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
