/**
 * Fix isnad/matn splits where prophet references ended up in the isnad
 * instead of the matn. Covers: "said", "I heard", "used to", "ordered",
 * "forbade", "that the messenger", "indeed the messenger", "saying".
 *
 * Finds the LAST occurrence of these phrases in the isnad and moves everything
 * from that point to the beginning of matn.
 *
 * Usage:
 *   bun run pipelines/import/fix-prophet-said-split.ts --dry-run
 *   bun run pipelines/import/fix-prophet-said-split.ts
 */

import "../env";
import { prisma } from "../../src/db";

const dryRun = process.argv.includes("--dry-run");

// ﷺ with optional dashes/spaces around it
const SAW = `(?:ﷺ|-\\s*ﷺ\\s*-|صَلَّى\\s+اللهُ\\s+عَلَيْهِ\\s+وَسَلَّمَ|صلى\\s+الله\\s+عليه\\s+وسلم)?`;
// الله with tashkeel variants
const ALLAH = `الله[ِه]?|اللَّهِ`;
// Messenger / Prophet titles
const RASUL = `رَسُولُ\\s+(?:${ALLAH})|رسول\\s+الله`;
const RASUL_ACC = `رَسُولَ\\s+(?:${ALLAH})|رسول\\s+الله`; // accusative
const NABI = `النَّبِيُّ|النبي[ُّ]?`;
const NABI_ACC = `النَّبِيَّ|النبي[َّ]?`; // accusative
const NABI_ALLAH = `نَبِيُّ\\s+(?:${ALLAH})|نبي\\s+الله`;

// Patterns that should be at the start of matn, not end of isnad
const PROPHET_SAID_PATTERNS: RegExp[] = [
  // "the messenger/prophet said" — قال رسول الله / قال النبي
  new RegExp(`(?:ف|و)?قَالَ\\s+(?:${RASUL})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?قال\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?قَالَ\\s+(?:${NABI})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?قال\\s+النبي[ُّ]?\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?قَالَ\\s+(?:${NABI_ALLAH})\\s*${SAW}`, "g"),
  // "he said to him/her"
  new RegExp(`(?:ف|و)?قَالَ\\s+لَه[ُا]\\s+(?:${RASUL})\\s*${SAW}`, "g"),
  // "I heard the messenger/prophet" — سمعت رسول الله
  new RegExp(`سَمِعْتُ\\s+(?:${RASUL_ACC})\\s*${SAW}`, "g"),
  new RegExp(`سمعت\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  new RegExp(`سَمِعْتُ\\s+(?:${NABI_ACC})\\s*${SAW}`, "g"),
  new RegExp(`سمعت\\s+النبي[َّ]?\\s*${SAW}`, "g"),
  // "that the messenger/prophet" — أن رسول الله
  new RegExp(`أَنَّ\\s+(?:${RASUL_ACC})\\s*${SAW}`, "g"),
  new RegExp(`أن\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  new RegExp(`أَنَّ\\s+(?:${NABI_ACC})\\s*${SAW}`, "g"),
  new RegExp(`أن\\s+النبي[َّ]?\\s*${SAW}`, "g"),
  // "indeed the messenger" — إن رسول الله
  new RegExp(`إِنَّ\\s+(?:${RASUL_ACC})\\s*${SAW}`, "g"),
  new RegExp(`إن\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  // "the messenger was / used to" — كان رسول الله / كان النبي
  new RegExp(`(?:ف|و)?كَانَ\\s+(?:${RASUL})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?كان\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?كَانَ\\s+(?:${NABI})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف|و)?كان\\s+النبي[ُّ]?\\s*${SAW}`, "g"),
  // "the messenger ordered" — أمر رسول الله
  new RegExp(`(?:ف)?أَمَرَ\\s+(?:${RASUL})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف)?أمر\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  // "the messenger forbade" — نهى رسول الله
  new RegExp(`(?:ف)?نَهَى\\s+(?:${RASUL})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف)?نهى\\s+رسول\\s+الله\\s*${SAW}`, "g"),
  new RegExp(`(?:ف)?نَهَى\\s+(?:${NABI})\\s*${SAW}`, "g"),
  new RegExp(`(?:ف)?نهى\\s+النبي[ُّ]?\\s*${SAW}`, "g"),
  // "the messenger saying" — رسول الله يقول
  new RegExp(`(?:${RASUL})\\s*${SAW}\\s*يَقُولُ`, "g"),
  new RegExp(`رسول\\s+الله\\s*${SAW}\\s*يقول`, "g"),
];

async function main() {
  // Query all affected hadiths
  const hadiths = (await prisma.$queryRawUnsafe(`
    SELECT id, isnad, matn FROM hadiths
    WHERE isnad IS NOT NULL AND isnad != ''
      AND matn IS NOT NULL AND matn != ''
      AND (
        isnad LIKE '%قَالَ رَسُولُ الله%'
        OR isnad LIKE '%قال رسول الله%'
        OR isnad LIKE '%قَالَ النَّبِيُّ%'
        OR isnad LIKE '%قال النبي%'
        OR isnad LIKE '%قَالَ لَهُ رَسُولُ%'
        OR isnad LIKE '%قَالَ نَبِيُّ%'
        OR isnad LIKE '%سَمِعْتُ رَسُولَ الله%'
        OR isnad LIKE '%سمعت رسول الله%'
        OR isnad LIKE '%سَمِعْتُ النَّبِيَّ%'
        OR isnad LIKE '%سمعت النبي%'
        OR isnad LIKE '%أَنَّ رَسُولَ الله%'
        OR isnad LIKE '%أن رسول الله%'
        OR isnad LIKE '%أَنَّ النَّبِيَّ%'
        OR isnad LIKE '%أن النبي%'
        OR isnad LIKE '%إِنَّ رَسُولَ الله%'
        OR isnad LIKE '%إن رسول الله%'
        OR isnad LIKE '%كَانَ رَسُولُ الله%'
        OR isnad LIKE '%كان رسول الله%'
        OR isnad LIKE '%كَانَ النَّبِيُّ%'
        OR isnad LIKE '%كان النبي%'
        OR isnad LIKE '%أَمَرَ رَسُولُ الله%'
        OR isnad LIKE '%أمر رسول الله%'
        OR isnad LIKE '%نَهَى رَسُولُ الله%'
        OR isnad LIKE '%نهى رسول الله%'
        OR isnad LIKE '%نَهَى النَّبِيُّ%'
        OR isnad LIKE '%نهى النبي%'
        OR isnad LIKE '%رَسُولُ اللهِ%يَقُولُ%'
        OR isnad LIKE '%رسول الله%يقول%'
        OR isnad LIKE '%قال صلى الله عليه%'
        OR isnad LIKE '%قَالَ صَلَّى الله%'
      )
  `)) as Array<{ id: number; isnad: string; matn: string }>;

  console.log(`Total affected hadiths: ${hadiths.length}`);

  const updates: Array<{ id: number; newIsnad: string; newMatn: string }> = [];
  const warnings: number[] = [];

  for (const h of hadiths) {
    let lastMatchIdx = -1;

    for (const pattern of PROPHET_SAID_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(h.isnad)) !== null) {
        if (match.index > lastMatchIdx) {
          lastMatchIdx = match.index;
        }
      }
    }

    if (lastMatchIdx === -1) {
      warnings.push(h.id);
      continue;
    }

    // Split: everything before the match stays as isnad
    let newIsnad = h.isnad.slice(0, lastMatchIdx).trim();
    // Clean up trailing punctuation
    newIsnad = newIsnad.replace(/[,،:\s]+$/, "").trim();

    let movedPart = h.isnad.slice(lastMatchIdx).trim();

    // Combine moved part with existing matn
    let newMatn = movedPart + " " + h.matn;
    newMatn = newMatn.replace(/ {2,}/g, " ").trim();

    updates.push({ id: h.id, newIsnad, newMatn });
  }

  console.log(`Fixes to apply: ${updates.length}`);
  if (warnings.length > 0) {
    console.log(`Warnings (no regex match): ${warnings.length} — IDs: ${warnings.slice(0, 10).join(", ")}${warnings.length > 10 ? "..." : ""}`);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN: First 15 examples ---");
    for (const u of updates.slice(0, 15)) {
      console.log(`\nID: ${u.id}`);
      console.log(`  New isnad (last 80): ...${u.newIsnad.slice(-80)}`);
      console.log(`  New matn (first 100): ${u.newMatn.slice(0, 100)}...`);
    }
    console.log("\nDry run — no changes made.");
    return;
  }

  // Apply updates
  let applied = 0;
  for (const u of updates) {
    await prisma.hadith.update({
      where: { id: u.id },
      data: { isnad: u.newIsnad, matn: u.newMatn },
    });
    applied++;
  }
  console.log(`Applied ${applied} updates`);

  // Verify: count remaining
  const remaining = (await prisma.$queryRawUnsafe(`
    SELECT count(*) as cnt FROM hadiths
    WHERE isnad IS NOT NULL AND isnad != ''
      AND matn IS NOT NULL AND matn != ''
      AND (
        isnad LIKE '%قَالَ رَسُولُ الله%'
        OR isnad LIKE '%قال رسول الله%'
        OR isnad LIKE '%قَالَ النَّبِيُّ%'
        OR isnad LIKE '%قال النبي%'
        OR isnad LIKE '%سَمِعْتُ رَسُولَ الله%'
        OR isnad LIKE '%سمعت رسول الله%'
        OR isnad LIKE '%كَانَ رَسُولُ الله%'
        OR isnad LIKE '%كان رسول الله%'
        OR isnad LIKE '%نَهَى رَسُولُ الله%'
        OR isnad LIKE '%نهى رسول الله%'
        OR isnad LIKE '%أَمَرَ رَسُولُ الله%'
        OR isnad LIKE '%أمر رسول الله%'
      )
  `)) as Array<{ cnt: bigint }>;
  console.log(`Remaining after fix: ${remaining[0].cnt}`);
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
