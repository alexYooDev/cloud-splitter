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

  constructor(auth: OAuth2Client, private readonly options: SplitOptions) {
    super();
    this.drive = google.drive({ version: "v3", auth });
  }

  async run(files: CloudFile[]): Promise<void> {
    const parts = planZipParts(files, this.options);
    this.emit("plan:complete", { partCount: parts.length });

    await mkdir(this.options.destinationDir, { recursive: true });

    for (const part of parts) {
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

    try {
      for (const file of part.files) {
        await this.appendFile(archive, file, part.partIndex);
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
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
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

    const res = await this.drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "stream" });
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
