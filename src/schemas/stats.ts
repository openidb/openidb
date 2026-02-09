import { z } from "@hono/zod-openapi";

export const StatsResponse = z.object({
  bookCount: z.number(),
  authorCount: z.number(),
  hadithCount: z.number(),
  categoryCount: z.number(),
}).openapi("Stats");
