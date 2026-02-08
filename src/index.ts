import { Hono } from "hono";
import { cors } from "hono/cors";
import { quranRoutes } from "./routes/quran";
import { hadithRoutes } from "./routes/hadith";
import { booksRoutes } from "./routes/books";
import { authorsRoutes } from "./routes/authors";
import { categoriesRoutes } from "./routes/categories";
import { searchRoutes } from "./routes/search";
import { transcribeRoutes } from "./routes/transcribe";
import { statsRoutes } from "./routes/stats";

const app = new Hono();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  "/api/*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

app.route("/api/search", searchRoutes);
app.route("/api/quran", quranRoutes);
app.route("/api/hadith", hadithRoutes);
app.route("/api/books/authors", authorsRoutes);
app.route("/api/books/categories", categoriesRoutes);
app.route("/api/books", booksRoutes);
app.route("/api/transcribe", transcribeRoutes);
app.route("/api/stats", statsRoutes);

app.get("/api/health", (c) => c.json({ status: "ok" }));

export default { port: 4000, fetch: app.fetch };
