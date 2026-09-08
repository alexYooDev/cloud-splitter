/** A single file discovered while scanning a cloud folder, flattened with its relative path. */
export interface CloudFile {
  id: string;
  name: string;
  /** Path relative to the scanned root folder, e.g. "Photos/2023/img.jpg" */
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
}

/** Result of scanning a cloud folder: all files found, plus any that couldn't be read. */
export interface ScanResult {
  files: CloudFile[];
  errors: { fileId: string; message: string }[];
}

/** One planned output ZIP part, and the files assigned to it. */
export interface ZipPlanPart {
  partIndex: number;
  files: CloudFile[];
  totalSizeBytes: number;
  /** True if this part holds a single file that exceeds the split size on its own (MVP: not spanned). */
  isOversizedStandalone: boolean;
}

export interface SplitOptions {
  /** Target max size per ZIP part, in bytes (e.g. 3.9 * 1024**3 for FAT32). */
  splitSizeBytes: number;
  destinationDir: string;
}
