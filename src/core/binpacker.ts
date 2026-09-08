import type { CloudFile, SplitOptions, ZipPlanPart } from "./types.js";

/**
 * Packs scanned files into ZIP parts under the target split size.
 *
 * Files are streamed into a part in scan order (a single continuous ZIP
 * stream that gets closed once the threshold is crossed) rather than
 * reordered for optimal packing — the download is sequential and
 * write-once, so there's no opportunity to backfill a part after moving on.
 *
 * A file larger than splitSizeBytes on its own becomes a standalone part
 * (isOversizedStandalone: true) per the MVP edge case in the PRD — it is
 * not spanned across multiple ZIPs.
 */
export function planZipParts(files: CloudFile[], options: SplitOptions): ZipPlanPart[] {
  if (options.splitSizeBytes <= 0) {
    throw new Error(`splitSizeBytes must be positive, got ${options.splitSizeBytes}`);
  }

  const parts: ZipPlanPart[] = [];
  let currentFiles: CloudFile[] = [];
  let currentSize = 0;

  const flush = () => {
    if (currentFiles.length === 0) return;
    parts.push({
      partIndex: parts.length + 1,
      files: currentFiles,
      totalSizeBytes: currentSize,
      isOversizedStandalone: false,
    });
    currentFiles = [];
    currentSize = 0;
  };

  for (const file of files) {
    if (file.sizeBytes > options.splitSizeBytes) {
      flush();
      parts.push({
        partIndex: parts.length + 1,
        files: [file],
        totalSizeBytes: file.sizeBytes,
        isOversizedStandalone: true,
      });
      continue;
    }

    if (currentSize + file.sizeBytes > options.splitSizeBytes) {
      flush();
    }

    currentFiles.push(file);
    currentSize += file.sizeBytes;
  }
  flush();

  return parts;
}
