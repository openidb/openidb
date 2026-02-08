/**
 * Embeddings Module
 *
 * Generates embeddings using Google Gemini embedding-001 via OpenRouter (3072 dimensions).
 */

import {
  generateEmbedding as generateEmbeddingGemini,
  generateEmbeddings as generateEmbeddingsGemini,
  normalizeArabicText,
  truncateForEmbedding,
} from "./gemini";

import { EMBEDDING_DIMENSIONS } from "../constants";

// Re-export utilities and constants
export {
  normalizeArabicText,
  truncateForEmbedding,
  EMBEDDING_DIMENSIONS,
};

/**
 * Generate embedding for a single text string
 *
 * @param text - Text to embed
 * @returns Promise<number[]> - Embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return generateEmbeddingGemini(text);
}

/**
 * Generate embeddings for multiple text strings
 *
 * @param texts - Array of texts to embed
 * @returns Promise<number[][]> - Array of embedding vectors
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return generateEmbeddingsGemini(texts);
}
