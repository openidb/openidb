import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { prisma } from "../db";
import { SOURCES } from "../utils/source-urls";
import { ErrorResponse } from "../schemas/common";
import {
  CategoryListQuery, CategoryIdParam, CategoryDetailQuery,
  CategoryListResponse, CategoryDetailResponse,
} from "../schemas/categories";

// --- Category list cache (5-minute TTL) ---
const CACHE_TTL_MS = 5 * 60 * 1000;
const categoryCache = new Map<string, { data: unknown; expiry: number }>();

function getCached<T>(key: string): T | null {
  const entry = categoryCache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data as T;
  categoryCache.delete(key);
  return null;
}

function setCache(key: string, data: unknown) {
  categoryCache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

const listCategories = createRoute({
  method: "get",
  path: "/",
  tags: ["Categories"],
  summary: "Get category list (tree or flat)",
  request: { query: CategoryListQuery },
  responses: {
    200: {
      content: { "application/json": { schema: CategoryListResponse } },
      description: "Category list",
    },
  },
});

const getCategory = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Categories"],
  summary: "Get category with books",
  request: {
    params: CategoryIdParam,
    query: CategoryDetailQuery,
  },
  responses: {
    200: {
      content: { "application/json": { schema: CategoryDetailResponse } },
      description: "Category details with books",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Category not found",
    },
  },
});

export const categoriesRoutes = new OpenAPIHono();

categoriesRoutes.openapi(listCategories, async (c) => {
  const { flat } = c.req.valid("query");
  const cacheKey = flat === "true" ? "flat" : "tree";

  const cached = getCached<{ categories: unknown; _sources: unknown }>(cacheKey);
  if (cached) return c.json(cached, 200);

  const categories = await prisma.category.findMany({
    orderBy: { nameArabic: "asc" },
    select: {
      id: true,
      code: true,
      nameArabic: true,
      nameEnglish: true,
      parentId: true,
      _count: { select: { books: true } },
    },
  });

  if (flat === "true") {
    const result = {
      categories: categories.map((cat) => ({
        id: cat.id,
        code: cat.code,
        nameArabic: cat.nameArabic,
        nameEnglish: cat.nameEnglish,
        parentId: cat.parentId,
        booksCount: cat._count.books,
      })),
      _sources: [...SOURCES.turath],
    };
    setCache(cacheKey, result);
    return c.json(result, 200);
  }

  // Build tree structure
  type CategoryNode = {
    id: number;
    code: string | null;
    nameArabic: string;
    nameEnglish: string | null;
    booksCount: number;
    children: CategoryNode[];
  };

  const nodeMap = new Map<number, CategoryNode>();
  const roots: CategoryNode[] = [];

  for (const cat of categories) {
    nodeMap.set(cat.id, {
      id: cat.id,
      code: cat.code,
      nameArabic: cat.nameArabic,
      nameEnglish: cat.nameEnglish,
      booksCount: cat._count.books,
      children: [],
    });
  }

  for (const cat of categories) {
    const node = nodeMap.get(cat.id)!;
    if (cat.parentId && nodeMap.has(cat.parentId)) {
      nodeMap.get(cat.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const result = {
    categories: roots,
    _sources: [...SOURCES.turath],
  };
  setCache(cacheKey, result);
  return c.json(result, 200);
});

categoriesRoutes.openapi(getCategory, async (c) => {
  const { id } = c.req.valid("param");
  const { limit, offset } = c.req.valid("query");

  const category = await prisma.category.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      nameArabic: true,
      nameEnglish: true,
      parent: { select: { id: true, nameArabic: true } },
      children: { select: { id: true, nameArabic: true, nameEnglish: true } },
    },
  });

  if (!category) {
    return c.json({ error: "Category not found" }, 404);
  }

  const [books, total] = await Promise.all([
    prisma.book.findMany({
      where: { categoryId: id },
      orderBy: { titleArabic: "asc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        titleArabic: true,
        titleLatin: true,
        author: { select: { nameArabic: true, nameLatin: true } },
      },
    }),
    prisma.book.count({ where: { categoryId: id } }),
  ]);

  return c.json({
    category,
    books,
    total,
    limit,
    offset,
    _sources: [...SOURCES.turath],
  }, 200);
});
