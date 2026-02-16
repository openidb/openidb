import { z } from "@hono/zod-openapi";
import { PaginationQuery, SourceSchema } from "./common";

export const AuthorListQuery = PaginationQuery.extend({
  search: z.string().max(500).optional().openapi({ example: "ابن تيمية" }),
  century: z.string().optional().openapi({ example: "3,7", description: "Hijri century(ies), comma-separated" }),
});

export const AuthorIdParam = z.object({
  id: z.string().max(50).openapi({ example: "123", description: "Author ID" }),
});

export const AuthorDetailQuery = z.object({
  bookTitleLang: z.string().max(20).optional().openapi({ example: "en", description: "Language code for book title translation" }),
});

export const AuthorSummary = z.object({
  id: z.string(),
  nameArabic: z.string(),
  nameLatin: z.string().nullable(),
  deathDateHijri: z.string().nullable(),
  deathDateGregorian: z.string().nullable(),
  booksCount: z.number(),
});

export const AuthorListResponse = z.object({
  authors: z.array(AuthorSummary),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  _sources: z.array(SourceSchema),
}).openapi("AuthorList");

export const AuthorDetailResponse = z.object({
  author: z.object({
    id: z.string(),
    nameArabic: z.string(),
    nameLatin: z.string().nullable(),
    kunya: z.string().nullable(),
    nasab: z.string().nullable(),
    nisba: z.string().nullable(),
    laqab: z.string().nullable(),
    birthDateHijri: z.string().nullable(),
    deathDateHijri: z.string().nullable(),
    birthDateGregorian: z.string().nullable(),
    deathDateGregorian: z.string().nullable(),
    biography: z.string().nullable(),
    biographySource: z.string().nullable(),
    books: z.array(z.object({
      id: z.string(),
      titleArabic: z.string(),
      titleLatin: z.string().nullable(),
      titleTranslated: z.string().nullable().optional(),
    })),
  }),
  _sources: z.array(SourceSchema),
}).openapi("AuthorDetail");
