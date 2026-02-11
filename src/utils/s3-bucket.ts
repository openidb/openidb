/**
 * S3 bucket initialization and health check utilities.
 */

import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { s3, BUCKET_NAME } from "../s3";

/**
 * Ensure the target bucket exists. Idempotent — safe to call multiple times.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
    console.log(`[s3] Created bucket: ${BUCKET_NAME}`);
  }
}

/**
 * Quick health check for S3 connectivity (3s timeout).
 */
export async function checkS3Health(): Promise<"ok" | "error"> {
  try {
    await Promise.race([
      s3.send(new ListBucketsCommand({})),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 3000)
      ),
    ]);
    return "ok";
  } catch {
    return "error";
  }
}
