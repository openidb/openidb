/**
 * Validate Extracted Knowledge Graph Files
 *
 * Checks all extracted-*.json files for:
 * 1. Valid JSON matching the expected schema
 * 2. Entity ID consistency (no near-duplicates)
 * 3. Relationship target validation (all targets exist)
 * 4. Summary statistics
 *
 * Usage: bun run pipelines/knowledge-graph/validate-extractions.ts
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");

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

const VALID_ENTITY_TYPES = new Set([
  "Prophet",
  "Person",
  "Angel",
  "Nation",
  "Place",
  "AfterlifePlace",
  "Event",
  "Concept",
  "DivineAttribute",
  "Ruling",
  "Scripture",
  "Object",
  "TimeReference",
]);

function main() {
  console.log("Validating Knowledge Graph Extractions");
  console.log("=".repeat(60));

  const extractionFiles = readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("extracted-") && f.endsWith(".json"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)![0]);
      const numB = parseInt(b.match(/\d+/)![0]);
      return numA - numB;
    });

  const surahDumpFiles = readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("surah-") && f.endsWith(".json"))
    .sort();

  console.log(`Found ${extractionFiles.length} extraction files`);
  console.log(`Found ${surahDumpFiles.length} surah dump files`);

  // Check which surahs are missing
  const extractedSurahs = new Set(
    extractionFiles.map((f) => parseInt(f.match(/\d+/)![0]))
  );
  const missingSurahs: number[] = [];
  for (let i = 1; i <= 114; i++) {
    if (!extractedSurahs.has(i)) missingSurahs.push(i);
  }
  if (missingSurahs.length > 0) {
    console.log(
      `\nMISSING SURAHS (${missingSurahs.length}): ${missingSurahs.join(", ")}`
    );
  } else {
    console.log("\nAll 114 surahs have extraction files!");
  }

  // Collect all ayah group IDs from dumps
  const allAyahGroupIds = new Set<string>();
  for (const file of surahDumpFiles) {
    try {
      const dump = JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8"));
      for (const group of dump.groups) {
        allAyahGroupIds.add(group.id);
      }
    } catch {
      // skip invalid dumps
    }
  }

  // Parse and validate all extraction files
  const allEntities = new Map<string, { entity: Entity; files: string[] }>();
  const allRelationships: Relationship[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileStats: Array<{
    file: string;
    entities: number;
    relationships: number;
    mentionedIn: number;
  }> = [];

  for (const file of extractionFiles) {
    const filePath = join(DATA_DIR, file);
    let data: ExtractionFile;

    // 1. JSON validity
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (e) {
      errors.push(`${file}: Invalid JSON - ${e}`);
      continue;
    }

    // Schema validation
    if (!data.entities || !Array.isArray(data.entities)) {
      errors.push(`${file}: Missing or invalid 'entities' array`);
      continue;
    }
    if (!data.relationships || !Array.isArray(data.relationships)) {
      errors.push(`${file}: Missing or invalid 'relationships' array`);
      continue;
    }

    let mentionedInCount = 0;
    let entityRelCount = 0;

    // Validate entities
    for (const entity of data.entities) {
      if (!entity.id) {
        errors.push(`${file}: Entity missing 'id'`);
        continue;
      }
      if (!entity.type) {
        errors.push(`${file}: Entity ${entity.id} missing 'type'`);
      } else if (!VALID_ENTITY_TYPES.has(entity.type)) {
        warnings.push(
          `${file}: Entity ${entity.id} has unknown type '${entity.type}'`
        );
      }
      if (!entity.nameArabic) {
        errors.push(`${file}: Entity ${entity.id} missing 'nameArabic'`);
      }
      if (!entity.nameEnglish) {
        errors.push(`${file}: Entity ${entity.id} missing 'nameEnglish'`);
      }
      if (!entity.descriptionArabic) {
        warnings.push(
          `${file}: Entity ${entity.id} missing 'descriptionArabic'`
        );
      }
      if (!entity.descriptionEnglish) {
        warnings.push(
          `${file}: Entity ${entity.id} missing 'descriptionEnglish'`
        );
      }

      // Track entity across files
      const existing = allEntities.get(entity.id);
      if (existing) {
        existing.files.push(file);
      } else {
        allEntities.set(entity.id, { entity, files: [file] });
      }
    }

    // Validate relationships
    const entityIdsInFile = new Set(data.entities.map((e) => e.id));

    for (const rel of data.relationships) {
      if (!rel.source) {
        errors.push(`${file}: Relationship missing 'source'`);
        continue;
      }
      if (!rel.target) {
        errors.push(`${file}: Relationship missing 'target'`);
        continue;
      }
      if (!rel.type) {
        errors.push(
          `${file}: Relationship ${rel.source}->${rel.target} missing 'type'`
        );
        continue;
      }

      if (rel.type === "MENTIONED_IN") {
        mentionedInCount++;
        // Target should be an ayah group ID
        const targetId = rel.target.replace(/^ayahgroup:/, "");
        if (!allAyahGroupIds.has(targetId)) {
          warnings.push(
            `${file}: MENTIONED_IN target '${rel.target}' not found in any surah dump`
          );
        }
        if (!rel.role) {
          warnings.push(
            `${file}: MENTIONED_IN ${rel.source}->${rel.target} missing 'role'`
          );
        }
        if (!rel.context) {
          warnings.push(
            `${file}: MENTIONED_IN ${rel.source}->${rel.target} missing 'context'`
          );
        }
      } else {
        entityRelCount++;
        if (!rel.sources || rel.sources.length === 0) {
          warnings.push(
            `${file}: Relationship ${rel.source}->${rel.target} (${rel.type}) missing sources`
          );
        }
      }

      allRelationships.push(rel);
    }

    fileStats.push({
      file,
      entities: data.entities.length,
      relationships: entityRelCount,
      mentionedIn: mentionedInCount,
    });
  }

  // 2. Entity ID consistency — check for near-duplicates
  console.log("\n" + "=".repeat(60));
  console.log("ENTITY ID CONSISTENCY CHECK");

  const entityIds = Array.from(allEntities.keys()).sort();
  const idsByPrefix = new Map<string, string[]>();
  for (const id of entityIds) {
    const prefix = id.split(":")[0];
    if (!idsByPrefix.has(prefix)) idsByPrefix.set(prefix, []);
    idsByPrefix.get(prefix)!.push(id);
  }

  // Check for potential duplicates (same prefix, similar name slug)
  const potentialDups: string[][] = [];
  for (const [prefix, ids] of idsByPrefix) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const slugA = ids[i].split(":")[1];
        const slugB = ids[j].split(":")[1];
        // Check if one contains the other or edit distance is small
        if (
          slugA.includes(slugB) ||
          slugB.includes(slugA) ||
          levenshtein(slugA, slugB) <= 2
        ) {
          potentialDups.push([ids[i], ids[j]]);
        }
      }
    }
  }

  if (potentialDups.length > 0) {
    console.log(`\nPotential duplicate entity IDs (${potentialDups.length}):`);
    for (const [a, b] of potentialDups.slice(0, 30)) {
      console.log(`  ${a}  <-->  ${b}`);
    }
    if (potentialDups.length > 30) {
      console.log(`  ... and ${potentialDups.length - 30} more`);
    }
  } else {
    console.log("No potential duplicate entity IDs found.");
  }

  // 3. Relationship target validation
  console.log("\n" + "=".repeat(60));
  console.log("RELATIONSHIP TARGET VALIDATION");

  const allEntityIds = new Set(entityIds);
  let missingSourceCount = 0;
  let missingTargetCount = 0;

  for (const rel of allRelationships) {
    if (rel.type === "MENTIONED_IN") continue;

    if (!allEntityIds.has(rel.source)) {
      missingSourceCount++;
      if (missingSourceCount <= 10) {
        warnings.push(
          `Relationship source '${rel.source}' not found in any entity list (type: ${rel.type})`
        );
      }
    }
    if (!allEntityIds.has(rel.target)) {
      missingTargetCount++;
      if (missingTargetCount <= 10) {
        warnings.push(
          `Relationship target '${rel.target}' not found in any entity list (type: ${rel.type})`
        );
      }
    }
  }

  console.log(`Entity-entity relationships with missing source: ${missingSourceCount}`);
  console.log(`Entity-entity relationships with missing target: ${missingTargetCount}`);

  // 4. Summary stats
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY STATISTICS");

  const totalEntities = allEntities.size;
  const totalEntityRels = allRelationships.filter(
    (r) => r.type !== "MENTIONED_IN"
  ).length;
  const totalMentionedIn = allRelationships.filter(
    (r) => r.type === "MENTIONED_IN"
  ).length;

  console.log(`\nTotal unique entities: ${totalEntities}`);
  console.log(`Total entity-entity relationships: ${totalEntityRels}`);
  console.log(`Total MENTIONED_IN edges: ${totalMentionedIn}`);

  // Entities by type
  const byType = new Map<string, number>();
  for (const { entity } of allEntities.values()) {
    byType.set(entity.type, (byType.get(entity.type) || 0) + 1);
  }
  console.log("\nEntities by type:");
  for (const [type, count] of [...byType.entries()].sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${type}: ${count}`);
  }

  // Relationship types
  const relTypes = new Map<string, number>();
  for (const rel of allRelationships) {
    relTypes.set(rel.type, (relTypes.get(rel.type) || 0) + 1);
  }
  console.log("\nRelationship types (top 20):");
  for (const [type, count] of [...relTypes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    console.log(`  ${type}: ${count}`);
  }

  // Cross-surah entities (appearing in multiple files)
  const crossSurah = [...allEntities.entries()]
    .filter(([, v]) => v.files.length >= 3)
    .sort((a, b) => b[1].files.length - a[1].files.length);

  console.log(`\nMost common cross-surah entities (top 20):`);
  for (const [id, { files }] of crossSurah.slice(0, 20)) {
    console.log(`  ${id}: ${files.length} files`);
  }

  // Per-file stats
  console.log("\nPer-file statistics:");
  for (const stat of fileStats) {
    console.log(
      `  ${stat.file}: ${stat.entities} entities, ${stat.relationships} rels, ${stat.mentionedIn} mentions`
    );
  }

  // Errors and warnings
  if (errors.length > 0) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`ERRORS (${errors.length}):`);
    for (const err of errors) {
      console.log(`  ERROR: ${err}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`WARNINGS (${warnings.length}):`);
    for (const warn of warnings.slice(0, 50)) {
      console.log(`  WARN: ${warn}`);
    }
    if (warnings.length > 50) {
      console.log(`  ... and ${warnings.length - 50} more warnings`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Validation complete: ${errors.length} errors, ${warnings.length} warnings`
  );

  if (errors.length > 0) process.exit(1);
}

// Simple Levenshtein distance for near-duplicate detection
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[b.length][a.length];
}

main();
