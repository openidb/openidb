/**
 * S3 Client Singleton
 * Provides singleton S3 client for RustFS (S3-compatible object storage).
 */

import { S3Client } from "@aws-sdk/client-s3";

const globalForS3 = globalThis as unknown as {
  s3: S3Client | undefined;
};

export const s3 =
  globalForS3.s3 ??
  new S3Client({
    endpoint: process.env.RUSTFS_ENDPOINT || "http://localhost:9000",
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.RUSTFS_ACCESS_KEY || "openidb_access",
      secretAccessKey: process.env.RUSTFS_SECRET_KEY || "openidb_secret_change_me",
    },
    forcePathStyle: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForS3.s3 = s3;
}

export const BUCKET_NAME = process.env.RUSTFS_BUCKET || "book-pdfs";

export default s3;
