/**
 * Merge partial extraction files into a single extracted-{N}.json
 *
 * Usage: bun run pipelines/knowledge-graph/merge-parts.ts <surah-number>
 *
 * Reads extracted-{N}-part*.json files and merges them:
 * - Entities: deduplicated by ID (first occurrence wins)
 * - Relationships: all included, deduped by source+target+type
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const surahNumber = parseInt(process.argv[2]);

if (!surahNumber || surahNumber < 1 || surahNumber > 114) {
  console.error("Usage: bun run merge-parts.ts <surah-number>");
  process.exit(1);
}

interface SourceRef {
  type: "quran" | "hadith" | "tafsir" | "book";
  ref: string;
}

interface Entity {
  id: string;
  type: string;
  nameArabic: string;
  nameEnglish: string;
  descriptionArabic: string;
  descriptionEnglish: string;
  sources?: SourceRef[];
}

interface Relationship {
  source: string;
  target: string;
  type: string;
  description?: string;
  role?: string;
  context?: string;
  sources?: SourceRef[];
}

interface ExtractionFile {
  entities: Entity[];
  relationships: Relationship[];
}

// Find all part files
const partFiles = readdirSync(DATA_DIR)
  .filter(
    (f) =>
      f.startsWith(`extracted-${surahNumber}-part`) && f.endsWith(".json")
  )
  .sort((a, b) => {
    const numA = parseInt(a.match(/part(\d+)/)![1]);
    const numB = parseInt(b.match(/part(\d+)/)![1]);
    return numA - numB;
  });

if (partFiles.length === 0) {
  console.error(`No part files found for surah ${surahNumber}`);
  process.exit(1);
}

console.log(
  `Merging ${partFiles.length} parts for surah ${surahNumber}:`
);

const entityMap = new Map<string, Entity>();
const relSet = new Set<string>();
const allRelationships: Relationship[] = [];

for (const file of partFiles) {
  const data: ExtractionFile = JSON.parse(
    readFileSync(join(DATA_DIR, file), "utf-8")
  );

  console.log(
    `  ${file}: ${data.entities.length} entities, ${data.relationships.length} relationships`
  );

  // Deduplicate entities by ID (first occurrence wins for descriptions,
  // but merge sources)
  for (const entity of data.entities) {
    const existing = entityMap.get(entity.id);
    if (existing) {
      // Merge sources
      const existingSources = new Set(
        (existing.sources || []).map((s) => `${s.type}:${s.ref}`)
      );
      for (const src of entity.sources || []) {
        const key = `${src.type}:${src.ref}`;
        if (!existingSources.has(key)) {
          existing.sources = existing.sources || [];
          existing.sources.push(src);
          existingSources.add(key);
        }
      }
    } else {
      entityMap.set(entity.id, { ...entity });
    }
  }

  // Deduplicate relationships by source+target+type
  for (const rel of data.relationships) {
    const key = `${rel.source}|${rel.target}|${rel.type}`;
    if (!relSet.has(key)) {
      relSet.add(key);
      allRelationships.push(rel);
    }
  }
}

const merged: ExtractionFile = {
  entities: Array.from(entityMap.values()),
  relationships: allRelationships,
};

const outPath = join(DATA_DIR, `extracted-${surahNumber}.json`);
writeFileSync(outPath, JSON.stringify(merged, null, 2), "utf-8");

const entityRelCount = allRelationships.filter(
  (r) => r.type !== "MENTIONED_IN"
).length;
const mentionedInCount = allRelationships.filter(
  (r) => r.type === "MENTIONED_IN"
).length;

console.log(`\nMerged output: ${outPath}`);
console.log(`  ${merged.entities.length} unique entities`);
console.log(`  ${entityRelCount} entity-entity relationships`);
console.log(`  ${mentionedInCount} MENTIONED_IN edges`);
console.log(`  ${allRelationships.length} total relationships`);
