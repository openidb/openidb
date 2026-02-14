import { getCachedExpansion, setCachedExpansion } from "../../query-expansion-cache";
import { callOpenRouter } from "../../lib/openrouter";
import { RERANKER_CONFIG } from "./rerankers";
import { MAX_QUERY_LENGTH } from "./config";
import type { ExpandedQuery } from "./types";

export function getQueryExpansionModelId(model: string): string {
  return RERANKER_CONFIG[model]?.model ?? "google/gemini-3-flash-preview";
}

export async function expandQueryWithCacheInfo(query: string, model: string = "gemini-flash"): Promise<{ queries: ExpandedQuery[]; cached: boolean }> {
  const cached = getCachedExpansion(query);
  if (cached) {
    return { queries: cached, cached: true };
  }

  const fallback: ExpandedQuery[] = [{ query, weight: 1.0, reason: "Original query" }];

  try {
    const prompt = `You are a search query expansion expert for an Arabic/Islamic text search engine covering Quran, Hadith, and classical Islamic books.

User Query: "${query.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, 500)}"

Generate exactly 4 alternative search queries:

QUERY 1-2: PREDICTED ANSWER TEXT
- Write a snippet of the ACTUAL Arabic text you expect to find in the answer
- Quote the beginning of the ayah, hadith, or passage that answers this query
- Examples:
  - "ayat al-kursi" → "الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم"
  - "5 before 5" → "اغتنم خمسا قبل خمس شبابك قبل هرمك وصحتك قبل سقمك"
  - "the verse about patience" → "إنما يوفى الصابرون أجرهم بغير حساب"

QUERY 3-4: ARABIC TRANSLATION & EXPANSION
- Translate or expand the query into Arabic (or English if already Arabic)
- Use Arabic root variations, synonyms, and related Islamic terminology
- Examples:
  - "prayer times" → "مواقيت الصلاة" or "أوقات الصلوات الخمس"
  - "الزكاة" → "zakat obligation" or "أحكام الزكاة والصدقة"

Return ONLY a JSON array of 4 query strings:
["predicted answer 1", "predicted answer 2", "arabic expansion 1", "arabic expansion 2"]

IMPORTANT:
- For predicted answers, write the actual Arabic source text (ayah/hadith/passage), not a description
- Keep expansion queries 2-8 words, focused and searchable
- Don't repeat the original query`;

    const modelId = getQueryExpansionModelId(model);
    const result = await callOpenRouter({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      timeoutMs: 15000,
    });

    if (!result) {
      return { queries: fallback, cached: false };
    }

    const match = result.content.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn("Query expansion returned invalid format");
      return { queries: fallback, cached: false };
    }

    const expanded: string[] = JSON.parse(match[0]);

    const results: ExpandedQuery[] = [
      { query, weight: 1.0, reason: "Original query" },
    ];

    for (let i = 0; i < Math.min(expanded.length, 4); i++) {
      const expQuery = typeof expanded[i] === 'string' ? expanded[i] : null;
      if (expQuery && expQuery.trim() && expQuery !== query) {
        results.push({
          query: expQuery.trim().slice(0, MAX_QUERY_LENGTH),
          weight: 1.0,
          reason: `Expanded query ${i + 1}`,
        });
      }
    }

    setCachedExpansion(query, results);
    return { queries: results, cached: false };
  } catch (err) {
    console.warn("Query expansion error:", err);
    return { queries: fallback, cached: false };
  }
}
