/**
 * Elasticsearch Catalog Search
 *
 * Search functions for books and authors indices.
 * Returns ranked IDs for hybrid ES + PostgreSQL queries.
 * Returns null on ES errors to signal fallback to ILIKE.
 */

import { elasticsearch, ES_BOOKS_INDEX, ES_AUTHORS_INDEX } from "./elasticsearch";

const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const NUMERIC_REGEX = /^\d+$/;

/**
 * Search books in Elasticsearch.
 * Returns ranked book IDs or null if ES is unavailable.
 */
export async function searchBooksES(query: string, limit: number): Promise<string[] | null> {
  try {
    const trimmed = query.trim();
    if (!trimmed) return [];

    let esQuery: Record<string, unknown>;

    if (NUMERIC_REGEX.test(trimmed)) {
      // Numeric query: exact ID match (boosted) + prefix match
      esQuery = {
        bool: {
          should: [
            { term: { id: { value: trimmed, boost: 100 } } },
            { prefix: { id: { value: trimmed, boost: 10 } } },
          ],
        },
      };
    } else if (ARABIC_REGEX.test(trimmed)) {
      // Arabic query: search Arabic title + author name
      esQuery = {
        multi_match: {
          query: trimmed,
          fields: ["title_arabic^3", "title_arabic.exact^2", "author_name_arabic"],
          fuzziness: "AUTO",
          type: "best_fields",
        },
      };
    } else {
      // Latin query: search Latin title + author name
      esQuery = {
        multi_match: {
          query: trimmed,
          fields: ["title_latin^3", "author_name_latin"],
          fuzziness: "AUTO",
          type: "best_fields",
        },
      };
    }

    const result = await elasticsearch.search({
      index: ES_BOOKS_INDEX,
      size: limit,
      _source: ["id"],
      query: esQuery,
    });

    return result.hits.hits.map((hit) => (hit._source as { id: string }).id);
  } catch (error) {
    console.error("[ES] Books search failed, falling back to ILIKE:", error);
    return null;
  }
}

/**
 * Search authors in Elasticsearch.
 * Returns ranked author IDs or null if ES is unavailable.
 */
export async function searchAuthorsES(query: string, limit: number): Promise<string[] | null> {
  try {
    const trimmed = query.trim();
    if (!trimmed) return [];

    let esQuery: Record<string, unknown>;

    if (NUMERIC_REGEX.test(trimmed)) {
      // Numeric query: exact ID match (boosted) + prefix match
      esQuery = {
        bool: {
          should: [
            { term: { id: { value: trimmed, boost: 100 } } },
            { prefix: { id: { value: trimmed, boost: 10 } } },
          ],
        },
      };
    } else if (ARABIC_REGEX.test(trimmed)) {
      // Arabic query: search name + kunya/nasab/nisba/laqab
      esQuery = {
        multi_match: {
          query: trimmed,
          fields: [
            "name_arabic^3",
            "name_arabic.exact^2",
            "kunya^2",
            "nasab",
            "nisba^2",
            "laqab",
          ],
          fuzziness: "AUTO",
          type: "best_fields",
        },
      };
    } else {
      // Latin query: search Latin name
      esQuery = {
        multi_match: {
          query: trimmed,
          fields: ["name_latin^3"],
          fuzziness: "AUTO",
          type: "best_fields",
        },
      };
    }

    const result = await elasticsearch.search({
      index: ES_AUTHORS_INDEX,
      size: limit,
      _source: ["id"],
      query: esQuery,
    });

    return result.hits.hits.map((hit) => (hit._source as { id: string }).id);
  } catch (error) {
    console.error("[ES] Authors search failed, falling back to ILIKE:", error);
    return null;
  }
}
