import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { prisma } from "../db";
import { SOURCES } from "../utils/source-urls";
import { ErrorResponse } from "../schemas/common";
import {
  AuthorListQuery, AuthorIdParam,
  AuthorListResponse, AuthorDetailResponse,
} from "../schemas/authors";

const listAuthors = createRoute({
  method: "get",
  path: "/",
  tags: ["Authors"],
  summary: "List authors (paginated, searchable)",
  request: { query: AuthorListQuery },
  responses: {
    200: {
      content: { "application/json": { schema: AuthorListResponse } },
      description: "Paginated list of authors",
    },
  },
});

const getAuthor = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Authors"],
  summary: "Get author by ID",
  request: { params: AuthorIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: AuthorDetailResponse } },
      description: "Author details with books",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Author not found",
    },
  },
});

export const authorsRoutes = new OpenAPIHono();

authorsRoutes.openapi(listAuthors, async (c) => {
  const { limit, offset, search, century } = c.req.valid("query");

  // Build raw WHERE clauses for numeric ID sorting (id is a string column)
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (search) {
    conditions.push(`(a.name_arabic ILIKE $${paramIdx} OR a.name_latin ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  if (century) {
    const centuries = century.split(",").map(Number).filter((n) => n >= 1 && n <= 15);
    if (centuries.length > 0) {
      conditions.push(`a.death_date_hijri ~ '^[0-9]+$' AND CEIL(CAST(a.death_date_hijri AS DOUBLE PRECISION) / 100)::int = ANY($${paramIdx}::int[])`);
      params.push(centuries);
      paramIdx++;
    }
  }

  const whereSQL = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [idRows, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT a.id FROM authors a ${whereSQL} ORDER BY CAST(a.id AS INTEGER) LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      ...params, limit, offset,
    ),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM authors a ${whereSQL}`,
      ...params,
    ),
  ]);

  const orderedIds = idRows.map((r) => r.id);
  const total = Number(countRows[0]?.count ?? 0);

  const authors = orderedIds.length > 0
    ? await prisma.author.findMany({
        where: { id: { in: orderedIds } },
        select: {
          id: true,
          nameArabic: true,
          nameLatin: true,
          deathDateHijri: true,
          deathDateGregorian: true,
          _count: { select: { books: true } },
        },
      })
    : [];

  // Re-sort to match raw SQL numeric order
  const idOrder = new Map(orderedIds.map((id, i) => [id, i]));
  authors.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

  return c.json({
    authors: authors.map((a) => ({
      id: a.id,
      nameArabic: a.nameArabic,
      nameLatin: a.nameLatin,
      deathDateHijri: a.deathDateHijri,
      deathDateGregorian: a.deathDateGregorian,
      booksCount: a._count.books,
    })),
    total,
    limit,
    offset,
    _sources: [...SOURCES.turath],
  }, 200);
});

authorsRoutes.openapi(getAuthor, async (c) => {
  const { id } = c.req.valid("param");

  const author = await prisma.author.findUnique({
    where: { id },
    select: {
      id: true,
      nameArabic: true,
      nameLatin: true,
      kunya: true,
      nasab: true,
      nisba: true,
      laqab: true,
      birthDateHijri: true,
      deathDateHijri: true,
      birthDateGregorian: true,
      deathDateGregorian: true,
      biography: true,
      biographySource: true,
      books: {
        orderBy: { titleArabic: "asc" },
        select: {
          id: true,
          titleArabic: true,
          titleLatin: true,
        },
      },
    },
  });

  if (!author) {
    return c.json({ error: "Author not found" }, 404);
  }

  return c.json({
    author,
    _sources: [...SOURCES.turath],
  }, 200);
});
