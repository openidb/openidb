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

Generate exactly 2 alternative search queries:

QUERY 1: ENHANCED ARABIC QUERY
- Translate, expand, or rephrase the query using Arabic root variations, synonyms, and related Islamic terminology
- If the query is already Arabic, add related terms or rephrase with synonyms
- If the query is in another language, translate to Arabic with rich terminology
- Keep it 2-8 words, focused and searchable

QUERY 2: PREDICTED ANSWER TEXT
- Write a snippet of the ACTUAL Arabic source text you expect to find in the answer
- Quote the beginning of the ayah, hadith, or passage that answers this query
- Examples:
  - "ayat al-kursi" → "الله لا إله إلا هو الحي القيوم لا تأخذه سنة ولا نوم"
  - "5 before 5" → "اغتنم خمسا قبل خمس شبابك قبل هرمك وصحتك قبل سقمك"

Return ONLY a JSON array of 2 query strings:
["enhanced arabic query", "predicted answer text"]

IMPORTANT:
- For predicted answers, write the actual Arabic source text (ayah/hadith/passage), not a description
- Keep the enhanced query 2-8 words, focused and searchable
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

    const reasons = ["Enhanced Arabic", "Predicted answer"];
    for (let i = 0; i < Math.min(expanded.length, 2); i++) {
      const expQuery = typeof expanded[i] === 'string' ? expanded[i] : null;
      if (expQuery && expQuery.trim() && expQuery !== query) {
        results.push({
          query: expQuery.trim().slice(0, MAX_QUERY_LENGTH),
          weight: 1.0,
          reason: reasons[i],
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
