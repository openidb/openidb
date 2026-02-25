import { z } from "@hono/zod-openapi";
import { PaginationQuery, SourceSchema } from "./common";

export const CategoryListQuery = z.object({
  flat: z.enum(["true", "false"]).optional().openapi({ example: "false", description: "Return flat list instead of tree" }),
  century: z.string().optional().openapi({ example: "3,7", description: "Filter counts by century (comma-separated)" }),
  hasPdf: z.enum(["true"]).optional().openapi({ description: "Only count books with PDFs" }),
  isIndexed: z.enum(["true"]).optional().openapi({ description: "Only count indexed books" }),
});

export const CategoryIdParam = z.object({
  id: z.coerce.number().int().min(1).openapi({ example: 1, description: "Category ID" }),
});

export const CategoryDetailQuery = PaginationQuery;

export const CategoryFlat = z.object({
  id: z.number(),
  code: z.string().nullable(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
  parentId: z.number().nullable(),
  booksCount: z.number(),
});

const BaseCategoryNode = z.object({
  id: z.number(),
  code: z.string().nullable(),
  nameArabic: z.string(),
  nameEnglish: z.string().nullable(),
  booksCount: z.number(),
});

// For tree response, use a lazy schema for recursive children
export const CategoryNode: z.ZodType<{
  id: number;
  code: string | null;
  nameArabic: string;
  nameEnglish: string | null;
  booksCount: number;
  children: unknown[];
}> = BaseCategoryNode.extend({
  children: z.lazy(() => z.array(CategoryNode)),
}) as any;

export const CategoryListResponse = z.object({
  categories: z.array(z.any()),
  _sources: z.array(SourceSchema),
}).openapi("CategoryList");

export const CategoryDetailResponse = z.object({
  category: z.object({
    id: z.number(),
    code: z.string().nullable(),
    nameArabic: z.string(),
    nameEnglish: z.string().nullable(),
    parent: z.object({ id: z.number(), nameArabic: z.string() }).nullable(),
    children: z.array(z.object({
      id: z.number(),
      nameArabic: z.string(),
      nameEnglish: z.string().nullable(),
    })),
  }),
  books: z.array(z.object({
    id: z.string(),
    titleArabic: z.string(),
    titleLatin: z.string().nullable(),
    author: z.object({
      nameArabic: z.string(),
      nameLatin: z.string().nullable(),
    }).nullable(),
  })),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  _sources: z.array(SourceSchema),
}).openapi("CategoryDetail");
