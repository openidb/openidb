/**
 * Upload Quran audio files to RustFS (S3-compatible storage).
 * Usage: bun run pipelines/import/upload-quran-audio.ts
 */

import { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const AUDIO_DIR = "/Volumes/KIOXIA/quran-audio/everyayah/alafasy-128kbps";
const BUCKET = "quran-audio";
const PREFIX = "alafasy-128kbps";
const CONCURRENCY = 20;

const s3 = new S3Client({
  endpoint: process.env.RUSTFS_ENDPOINT || "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.RUSTFS_ACCESS_KEY || "openidb_access",
    secretAccessKey: process.env.RUSTFS_SECRET_KEY || "openidb_secret_change_me",
  },
  forcePathStyle: true,
});

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" exists`);
  } catch {
    console.log(`Creating bucket "${BUCKET}"...`);
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" created`);
  }
}

async function uploadFile(filename: string): Promise<void> {
  const filePath = join(AUDIO_DIR, filename);
  const key = `${PREFIX}/${filename}`;
  const body = await readFile(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: "audio/mpeg",
  }));
}

async function main() {
  await ensureBucket();

  const files = (await readdir(AUDIO_DIR)).filter(f => f.endsWith(".mp3")).sort();
  console.log(`Found ${files.length} mp3 files to upload`);

  let uploaded = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(f => uploadFile(f)));
    for (const r of results) {
      if (r.status === "fulfilled") uploaded++;
      else { failed++; console.error("Failed:", r.reason); }
    }
    if (uploaded % 200 === 0 || i + CONCURRENCY >= files.length) {
      console.log(`Progress: ${uploaded}/${files.length} uploaded, ${failed} failed`);
    }
  }

  console.log(`Done: ${uploaded} uploaded, ${failed} failed`);
}

main().catch(console.error);
