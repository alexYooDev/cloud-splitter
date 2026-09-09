import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import archiver from "archiver";
import { google, drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { ProgressEmitter } from "./events.js";
import type { CloudFile, SplitOptions, ZipPlanPart } from "./types.js";
import { planZipParts } from "./binpacker.js";
import { withRetry, type RetryOptions } from "./retry.js";

type FetchRetryTuning = Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs">;

function partFileName(partIndex: number): string {
  return `Part_${String(partIndex).padStart(2, "0")}.zip`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Thrown when cancel() interrupts a run — distinguishes a deliberate stop from a real failure. */
export class DownloadCancelledError extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "DownloadCancelledError";
  }
}

/**
 * Streams files from Google Drive directly into split ZIP parts.
 * No file is ever fully written to local disk outside of a ZIP part —
 * each file's HTTP response stream is piped straight into `archiver`.
 *
 * Splitting is decided up front by planZipParts (based on scanned file
 * sizes), then executed one part at a time: open Part_N.zip.tmp, stream
 * every planned file into it via archiver, finalize, and only then rename
 * to Part_N.zip. That atomic rename is what makes a completed part safe
 * to trust — a crash mid-part leaves only a stray .tmp file behind, never
 * a corrupt Part_N.zip. Re-running against the same destination directory
 * skips any part whose final .zip already exists, so a failed download
 * resumes from the first missing/incomplete part instead of starting over.
 */
export class CloudDownloader extends ProgressEmitter {
  private readonly drive: drive_v3.Drive;
  private cancelled = false;

  constructor(
    auth: OAuth2Client,
    private readonly options: SplitOptions,
    private readonly fetchRetryOptions: FetchRetryTuning = {}
  ) {
    super();
    this.drive = google.drive({ version: "v3", auth });
  }

  /**
   * Requests a graceful stop: the file currently being fetched is allowed to
   * finish (so its archive entry is never half-written), then the current
   * part is abandoned via the normal error-cleanup path — same as any other
   * mid-part failure, so it's simply redone in full on the next run. Earlier
   * completed parts are untouched.
   */
  cancel(): void {
    this.cancelled = true;
  }

  async run(files: CloudFile[]): Promise<void> {
    const parts = planZipParts(files, this.options);
    this.emit("plan:complete", { partCount: parts.length });

    await mkdir(this.options.destinationDir, { recursive: true });

    for (const part of parts) {
      if (this.cancelled) {
        throw new DownloadCancelledError();
      }
      await this.writePart(part, parts.length);
    }
  }

  private async writePart(part: ZipPlanPart, totalParts: number): Promise<void> {
    const finalPath = join(this.options.destinationDir, partFileName(part.partIndex));

    if (await fileExists(finalPath)) {
      return;
    }

    this.emit("part:start", { partIndex: part.partIndex, totalParts });

    if (part.isOversizedStandalone) {
      this.emit("file:warning", {
        fileId: part.files[0]!.id,
        message: `"${part.files[0]!.relativePath}" is larger than the split size and was placed in its own part (${partFileName(part.partIndex)}).`,
      });
    }

    const tmpPath = `${finalPath}.tmp`;
    const output = createWriteStream(tmpPath);
    const archive = archiver("zip", { store: true });
    archive.pipe(output);

    const closed = new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
    });
    // If a part is torn down mid-stream (cancellation, or a failure on a
    // later file after earlier ones already succeeded), archiver can still
    // have a buffered write in flight to `output` when we destroy it —
    // that write's resulting 'error' event fires after nothing is awaiting
    // `closed` anymore. Without this, that's an unhandled rejection; the
    // outcome is unaffected either way since the .tmp gets unlinked regardless.
    closed.catch(() => {});

    try {
      for (const file of part.files) {
        await this.appendFile(archive, file, part.partIndex);
        if (this.cancelled) {
          throw new DownloadCancelledError();
        }
      }
      await archive.finalize();
      await closed;
    } catch (err) {
      if (!output.destroyed) {
        // Wait for the fd to actually be released before unlinking — destroy()
        // doesn't complete synchronously, and if the underlying async open()
        // hadn't finished yet, an immediate unlink can race ahead of it and
        // silently miss the file once open() finally creates it.
        await new Promise<void>((resolve) => {
          output.once("close", resolve);
          output.destroy();
        });
      }
      await unlink(tmpPath).catch(() => {});
      // Once cancel() has been requested, prefer reporting cancellation over
      // whatever error actually triggered teardown — e.g. a retry backoff
      // aborted by shouldAbort() rethrows the original (possibly non-Error,
      // unfriendly) fetch failure, not a DownloadCancelledError. From the
      // user's perspective they asked to stop; that's the accurate outcome
      // regardless of which underlying error happened to surface first.
      const error = this.cancelled
        ? new DownloadCancelledError()
        : err instanceof Error
          ? err
          : new Error(String(err));
      if (!(error instanceof DownloadCancelledError)) {
        this.emit("error", error);
      }
      throw error;
    }

    await rename(tmpPath, finalPath);

    this.emit("part:complete", {
      partIndex: part.partIndex,
      sizeBytes: output.bytesWritten,
      outputPath: finalPath,
    });
  }

  private async appendFile(archive: archiver.Archiver, file: CloudFile, partIndex: number): Promise<void> {
    this.emit("file:start", { fileId: file.id, name: file.name, partIndex });

    // Retries only cover the request/connection phase — transient errors
    // (rate limiting, a dropped connection before any bytes arrive) are safe
    // to retry since nothing has been written to the archive yet. Once a
    // stream is handed to archive.append() below, a failure there is NOT
    // retried: archiver has already started writing that entry into the
    // part's single zip stream, and there's no safe way to "undo" a partial
    // entry and restart it without risking a corrupt part. That case is
    // still handled correctly, just at a coarser grain — it fails the whole
    // part, which the existing atomic tmp/rename + resume logic cleanly
    // redoes in full on the next run.
    const res = await withRetry(
      () => this.drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "stream" }),
      {
        ...this.fetchRetryOptions,
        shouldAbort: () => this.cancelled,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          this.emit("file:retry", {
            fileId: file.id,
            attempt,
            maxAttempts,
            message: `Retrying "${file.relativePath}" (attempt ${attempt}/${maxAttempts}, waiting ${Math.round(delayMs / 1000)}s) after: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      }
    );
    const stream: Readable = res.data;

    let bytesWritten = 0;
    stream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      this.emit("file:progress", { fileId: file.id, bytesWritten, totalBytes: file.sizeBytes });
    });

    await new Promise<void>((resolve, reject) => {
      const onEntry = (entry: { name: string }) => {
        if (entry.name === file.relativePath) {
          archive.removeListener("entry", onEntry);
          resolve();
        }
      };
      stream.on("error", reject);
      archive.on("entry", onEntry);
      archive.append(stream, { name: file.relativePath });
    });

    this.emit("file:complete", { fileId: file.id });
  }
}
