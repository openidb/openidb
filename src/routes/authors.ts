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
  const { limit, offset, search } = c.req.valid("query");

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { nameArabic: { contains: search, mode: "insensitive" } },
      { nameLatin: { contains: search, mode: "insensitive" } },
    ];
  }

  const [authors, total] = await Promise.all([
    prisma.author.findMany({
      where,
      orderBy: { nameArabic: "asc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        nameArabic: true,
        nameLatin: true,
        deathDateHijri: true,
        deathDateGregorian: true,
        _count: { select: { books: true } },
      },
    }),
    prisma.author.count({ where }),
  ]);

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
    _sources: [...SOURCES.shamela],
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
    _sources: [...SOURCES.shamela],
  }, 200);
});
