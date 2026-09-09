import type { Readable } from "node:stream";
import type { ScanResult } from "./types.js";

/** One entry from a non-recursive folder listing — used by the interactive browser. */
export interface CloudItem {
  id: string;
  name: string;
  isFolder: boolean;
  /** Present for files; omitted for folders. */
  sizeBytes?: number;
  /** Present for files; used for provider-specific classification (e.g. skipping unsupported file types). */
  mimeType?: string;
}

/**
 * A cloud storage backend CloudSplitter can stream files from. This is the
 * only seam between the CLI/interactive picker and provider-specific auth +
 * API details — binpacker.ts, downloader.ts's split/resume logic, and
 * retry.ts are all provider-agnostic and never import googleapis or MSAL
 * directly.
 *
 * Implementations must throw errors with a numeric `.status` set on API
 * failures (fetchFileStream in particular) so retry.ts's isTransientError
 * can classify 429/5xx consistently across providers.
 */
export interface CloudProvider {
  /** Human-readable name for CLI messages, e.g. "Google Drive" or "OneDrive". */
  readonly name: string;

  /** Non-recursive: one folder's immediate children, for the interactive browser. "root" means the drive's top level. */
  listChildren(folderId: string): Promise<CloudItem[]>;

  /** Metadata for a single id — used to tell whether a given id is a file or a folder. */
  getItemMetadata(itemId: string): Promise<CloudItem>;

  /** Recursively resolves a file or folder id into a flat, streamable file list. */
  scanTarget(targetId: string): Promise<ScanResult>;

  /** Opens a readable stream of a file's content, for piping into archiver. */
  fetchFileStream(fileId: string): Promise<Readable>;
}
