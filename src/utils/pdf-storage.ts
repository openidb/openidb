/**
 * PDF storage detection helper.
 * Determines whether a page's pdfUrl points to RustFS or an external source.
 */

export type PdfStorageInfo =
  | { type: "rustfs"; key: string }
  | { type: "external"; url: string }
  | { type: "none" };

/**
 * Detect the storage type from a page's pdfUrl field.
 *
 * - Starts with "http" → external source URL (legacy / archive.org)
 * - No protocol prefix → RustFS object key (e.g. "26/0.pdf")
 * - null/undefined/empty → no PDF available
 */
export function detectPdfStorage(pdfUrl: string | null | undefined): PdfStorageInfo {
  if (!pdfUrl) return { type: "none" };

  if (pdfUrl.startsWith("http")) {
    return { type: "external", url: pdfUrl };
  }

  return { type: "rustfs", key: pdfUrl };
}
