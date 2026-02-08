import { Hono } from "hono";
import { prisma } from "../db";

export const statsRoutes = new Hono();

// GET / — database stats for homepage
statsRoutes.get("/", async (c) => {
  const [bookCount, authorCount, hadithCount, categoryCount] = await Promise.all([
    prisma.book.count(),
    prisma.author.count(),
    prisma.hadith.count(),
    prisma.category.count(),
  ]);

  return c.json({ bookCount, authorCount, hadithCount, categoryCount });
});
