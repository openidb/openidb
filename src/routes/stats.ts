import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { prisma } from "../db";
import { StatsResponse } from "../schemas/stats";

const getStats = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  summary: "Get database statistics",
  responses: {
    200: {
      content: { "application/json": { schema: StatsResponse } },
      description: "Database statistics",
    },
  },
});

export const statsRoutes = new OpenAPIHono();

statsRoutes.openapi(getStats, async (c) => {
  const [bookCount, authorCount, hadithCount, categoryCount] = await Promise.all([
    prisma.book.count(),
    prisma.author.count(),
    prisma.hadith.count(),
    prisma.category.count(),
  ]);

  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ bookCount, authorCount, hadithCount, categoryCount }, 200);
});
