import { google, drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Readable } from "node:stream";
import type { CloudItem, CloudProvider } from "../../provider.js";
import type { CloudFile, ScanResult } from "../../types.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
// Native Google Docs/Sheets/Slides/etc. have no binary size and can't be
// streamed via files.get(alt=media) — they'd need a separate export step.
// Out of scope for the MVP; scanned files of this kind are skipped with a warning.
const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";

interface QueueItem {
  folderId: string;
  relativePath: string;
}

type Classified =
  | { kind: "folder"; folderId: string }
  | { kind: "file"; file: CloudFile }
  | { kind: "error"; fileId: string; message: string };

function classify(item: CloudItem, relativePath: string): Classified {
  if (item.isFolder) {
    return { kind: "folder", folderId: item.id };
  }

  if (item.mimeType?.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
    return {
      kind: "error",
      fileId: item.id,
      message: `Skipped "${relativePath}": native Google Docs/Sheets/Slides files are not supported yet (export not implemented).`,
    };
  }

  if (item.sizeBytes === undefined) {
    return { kind: "error", fileId: item.id, message: `Skipped "${relativePath}": missing id or size.` };
  }

  return {
    kind: "file",
    file: {
      id: item.id,
      name: item.name,
      relativePath,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType ?? "application/octet-stream",
    },
  };
}

function toCloudItem(item: drive_v3.Schema$File): CloudItem {
  const isFolder = item.mimeType === FOLDER_MIME_TYPE;
  return {
    id: item.id ?? "unknown",
    name: item.name ?? item.id ?? "unknown",
    isFolder,
    sizeBytes: !isFolder && item.size != null ? Number(item.size) : undefined,
    mimeType: item.mimeType ?? undefined,
  };
}

/**
 * Google Drive implementation of CloudProvider. listChildren() is the one
 * "ask Drive for a folder's contents" implementation — scanTarget()'s
 * recursive walk is built on top of it (not a separate raw variant), so
 * interactive browsing and full-folder scanning always see the same data.
 */
export class GoogleDriveProvider implements CloudProvider {
  readonly name = "Google Drive";
  private readonly drive: drive_v3.Drive;

  constructor(auth: OAuth2Client) {
    this.drive = google.drive({ version: "v3", auth });
  }

  async getItemMetadata(itemId: string): Promise<CloudItem> {
    const { data } = await this.drive.files.get({
      fileId: itemId,
      fields: "id, name, mimeType, size",
      supportsAllDrives: true,
    });
    return toCloudItem(data);
  }

  async listChildren(folderId: string): Promise<CloudItem[]> {
    const items: CloudItem[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size)",
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const file of res.data.files ?? []) {
        items.push(toCloudItem(file));
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return items;
  }

  async scanTarget(targetId: string): Promise<ScanResult> {
    const target = await this.getItemMetadata(targetId);

    if (target.isFolder) {
      return this.walkFolder(targetId);
    }

    const classified = classify(target, target.name);
    if (classified.kind === "file") {
      return { files: [classified.file], errors: [] };
    }
    if (classified.kind === "error") {
      return { files: [], errors: [{ fileId: classified.fileId, message: classified.message }] };
    }
    // classify() only returns "folder" when target.isFolder, already handled above.
    throw new Error("unreachable");
  }

  private async walkFolder(rootFolderId: string): Promise<ScanResult> {
    const result: ScanResult = { files: [], errors: [] };
    const queue: QueueItem[] = [{ folderId: rootFolderId, relativePath: "" }];

    while (queue.length > 0) {
      const { folderId: currentId, relativePath } = queue.shift()!;

      let children: CloudItem[];
      try {
        children = await this.listChildren(currentId);
      } catch (err) {
        result.errors.push({
          fileId: currentId,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const child of children) {
        const childPath = relativePath ? `${relativePath}/${child.name}` : child.name;
        const classified = classify(child, childPath);

        if (classified.kind === "folder") {
          queue.push({ folderId: classified.folderId, relativePath: childPath });
        } else if (classified.kind === "file") {
          result.files.push(classified.file);
        } else {
          result.errors.push({ fileId: classified.fileId, message: classified.message });
        }
      }
    }

    return result;
  }

  async fetchFileStream(fileId: string): Promise<Readable> {
    const res = await this.drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
    return res.data;
  }
}
