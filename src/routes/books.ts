import { Hono } from "hono";
import { prisma } from "../db";
import { callOpenRouter } from "../lib/openrouter";
import { generateShamelaBookUrl, generateShamelaPageUrl, SOURCES } from "../utils/source-urls";
import { parsePagination } from "../utils/pagination";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", fr: "French", id: "Indonesian", ur: "Urdu",
  es: "Spanish", zh: "Chinese", pt: "Portuguese", ru: "Russian",
  ja: "Japanese", ko: "Korean", it: "Italian", bn: "Bengali",
};

const MODEL_MAP: Record<string, string> = {
  "gemini-flash": "google/gemini-3-flash-preview",
  "gpt-oss-120b": "openai/gpt-oss-120b",
};

const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function isMeaningfulContent(text: string): boolean {
  if (text.length < 2) return false;
  if (!ARABIC_REGEX.test(text)) return false;
  if (/^[\s\d\-–—_.*•·,،؛:;!?'"()[\]{}«»<>\/\\|@#$%^&+=~`]+$/.test(text)) return false;
  return true;
}

function extractParagraphs(html: string): { index: number; text: string }[] {
  const paragraphs: { index: number; text: string }[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  let index = 0;
  while ((match = pRegex.exec(html)) !== null) {
    const text = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
    if (isMeaningfulContent(text)) paragraphs.push({ index, text });
    index++;
  }
  return paragraphs;
}

export const booksRoutes = new Hono();

// GET / — list books (paginated, searchable)
booksRoutes.get("/", async (c) => {
  const search = c.req.query("search");
  const authorId = c.req.query("authorId");
  const categoryId = c.req.query("categoryId");
  const { limit, offset } = parsePagination(c.req.query("limit"), c.req.query("offset"));

  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { titleArabic: { contains: search, mode: "insensitive" } },
      { titleLatin: { contains: search, mode: "insensitive" } },
    ];
  }
  if (authorId) where.authorId = authorId;
  if (categoryId) where.categoryId = parseInt(categoryId, 10);

  const [books, total] = await Promise.all([
    prisma.book.findMany({
      where,
      orderBy: { titleArabic: "asc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        titleArabic: true,
        titleLatin: true,
        filename: true,
        totalVolumes: true,
        totalPages: true,
        publicationYearHijri: true,
        author: {
          select: { id: true, nameArabic: true, nameLatin: true },
        },
        category: {
          select: { id: true, nameArabic: true, nameEnglish: true },
        },
      },
    }),
    prisma.book.count({ where }),
  ]);

  return c.json({
    books: books.map((b) => ({
      ...b,
      shamelaUrl: generateShamelaBookUrl(b.id),
    })),
    total,
    limit,
    offset,
    _sources: SOURCES.shamela,
  });
});

// GET /:id — get book by id
booksRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");

  const book = await prisma.book.findUnique({
    where: { id },
    select: {
      id: true,
      titleArabic: true,
      titleLatin: true,
      filename: true,
      totalVolumes: true,
      totalPages: true,
      publicationYearHijri: true,
      publicationYearGregorian: true,
      publicationEdition: true,
      verificationStatus: true,
      descriptionHtml: true,
      summary: true,
      author: {
        select: {
          id: true,
          nameArabic: true,
          nameLatin: true,
          deathDateHijri: true,
        },
      },
      category: {
        select: { id: true, nameArabic: true, nameEnglish: true },
      },
      publisher: {
        select: { name: true, location: true },
      },
      editor: {
        select: { name: true },
      },
      keywords: {
        select: { keyword: true },
      },
    },
  });

  if (!book) {
    return c.json({ error: "Book not found" }, 404);
  }

  return c.json({
    book: {
      ...book,
      shamelaUrl: generateShamelaBookUrl(book.id),
    },
    _sources: SOURCES.shamela,
  });
});

// POST /:id/pages/:page/translate — translate page paragraphs
booksRoutes.post("/:id/pages/:page/translate", async (c) => {
  const bookId = c.req.param("id");
  const pageNumber = parseInt(c.req.param("page"), 10);

  if (isNaN(pageNumber)) {
    return c.json({ error: "Invalid page number" }, 400);
  }

  let body: { lang?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const lang = body.lang || "en";
  const modelKey = body.model || "gemini-flash";
  const model = MODEL_MAP[modelKey] || MODEL_MAP["gemini-flash"];

  const targetLanguage = LANGUAGE_NAMES[lang];
  if (!targetLanguage) {
    return c.json({ error: "Unsupported language" }, 400);
  }

  const page = await prisma.page.findUnique({
    where: { bookId_pageNumber: { bookId, pageNumber } },
    select: { id: true, contentHtml: true },
  });

  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  // Check cache
  const existing = await prisma.pageTranslation.findUnique({
    where: { pageId_language: { pageId: page.id, language: lang } },
  });
  if (existing) {
    return c.json({ paragraphs: existing.paragraphs, cached: true });
  }

  const paragraphs = extractParagraphs(page.contentHtml);
  if (paragraphs.length === 0) {
    return c.json({ paragraphs: [] });
  }

  const numberedParagraphs = paragraphs.map((p) => `[${p.index}] ${p.text}`).join("\n\n");

  const prompt = `Translate the following Arabic paragraphs to ${targetLanguage}.
Each paragraph is numbered with [N]. Return a JSON array where each element has "index" (the paragraph number) and "translation" (the translated text).
Only translate the text content - do not include the original Arabic or the [N] markers in the translation.
Preserve the meaning and tone of the original text.

IMPORTANT: Preserve Islamic terminology in their original Arabic form. Do NOT translate:
- "الله" → "Allah" (not "God")
- "محمد" → "Muhammad" or "the Prophet Muhammad"
- "القرآن" → "Quran" (not "the holy book")
- "الرسول" → "the Messenger" or "the Prophet"
- "صلى الله عليه وسلم" → "peace be upon him" or "ﷺ"
- Other Islamic terms like: Salah, Zakat, Hajj, Iman, Taqwa, Sunnah, Hadith, etc.

Arabic paragraphs:
${numberedParagraphs}

Respond with ONLY a valid JSON array, no other text. Example format:
[{"index": 0, "translation": "First paragraph translation"}, {"index": 1, "translation": "Second paragraph translation"}]`;

  const result = await callOpenRouter({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, timeoutMs: 30000 });
  if (!result) {
    return c.json({ error: "Translation service unavailable" }, 502);
  }

  let translations: { index: number; translation: string }[] = [];
  try {
    let cleaned = result.content.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    translations = JSON.parse(cleaned.trim());
  } catch {
    return c.json({ error: "Failed to parse translation" }, 500);
  }

  await prisma.pageTranslation.create({
    data: { pageId: page.id, language: lang, model: modelKey, paragraphs: translations },
  });

  return c.json({ paragraphs: translations, cached: false });
});

// GET /:id/pages/:page — get book page
booksRoutes.get("/:id/pages/:page", async (c) => {
  const bookId = c.req.param("id");
  const pageNumber = parseInt(c.req.param("page"), 10);

  if (isNaN(pageNumber)) {
    return c.json({ error: "Invalid page number" }, 400);
  }

  const page = await prisma.page.findUnique({
    where: { bookId_pageNumber: { bookId, pageNumber } },
    select: {
      pageNumber: true,
      volumeNumber: true,
      urlPageIndex: true,
      printedPageNumber: true,
      contentPlain: true,
      contentHtml: true,
      hasPoetry: true,
      hasHadith: true,
      hasQuran: true,
      sourceUrl: true,
    },
  });

  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({
    page: {
      ...page,
      shamelaUrl: generateShamelaPageUrl(bookId, pageNumber),
    },
    _sources: SOURCES.shamela,
  });
});

// GET /:id/pages — list pages for a book (metadata only)
booksRoutes.get("/:id/pages", async (c) => {
  const bookId = c.req.param("id");
  const { limit, offset } = parsePagination(c.req.query("limit"), c.req.query("offset"), 50, 200);

  const [pages, total] = await Promise.all([
    prisma.page.findMany({
      where: { bookId },
      orderBy: { pageNumber: "asc" },
      take: limit,
      skip: offset,
      select: {
        pageNumber: true,
        volumeNumber: true,
        urlPageIndex: true,
        printedPageNumber: true,
      },
    }),
    prisma.page.count({ where: { bookId } }),
  ]);

  return c.json({
    pages,
    total,
    limit,
    offset,
    _sources: SOURCES.shamela,
  });
});
