import type { RerankerType, SearchMode } from "./types";

export interface SearchParams {
  query: string;
  limit: number;
  bookId: string | null;
  mode: SearchMode;
  includeQuran: boolean;
  includeHadith: boolean;
  includeBooks: boolean;
  reranker: RerankerType;
  similarityCutoff: number;
  bookLimit: number;
  fuzzyEnabled: boolean;
  quranTranslation: string;
  hadithTranslation: string;
  bookTitleLang: string | undefined;
  bookContentTranslation: string;
  refine: boolean;
  refineSimilarityCutoff: number;
  refineOriginalWeight: number;
  refineExpandedWeight: number;
  refineBookPerQuery: number;
  refineAyahPerQuery: number;
  refineHadithPerQuery: number;
  refineBookRerank: number;
  refineAyahRerank: number;
  refineHadithRerank: number;
  queryExpansionModel: string;
  includeGraph: boolean;
}
