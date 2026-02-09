import { z } from "@hono/zod-openapi";

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
  offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
});

export const ErrorResponse = z.object({
  error: z.string(),
}).openapi("ErrorResponse");

export const ValidationErrorResponse = z.object({
  error: z.string(),
  details: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
}).openapi("ValidationErrorResponse");

export const SourceSchema = z.object({
  name: z.string(),
  url: z.string(),
  type: z.string(),
});

export const PaginatedMeta = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
