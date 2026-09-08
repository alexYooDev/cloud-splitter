import { google, drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { CloudFile, ScanResult } from "./types.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
// Native Google Docs/Sheets/Slides/etc. have no binary size and can't be
// streamed via files.get(alt=media) — they'd need a separate export step.
// Out of scope for the MVP; scanned files of this kind are skipped with a warning.
const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";

interface QueueItem {
  folderId: string;
  relativePath: string;
}

async function listChildren(drive: drive_v3.Drive, folderId: string): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/**
 * Recursively walks a Drive folder and returns a flat list of all files
 * inside it (including nested subfolders), with paths relative to the
 * scanned root and exact byte sizes.
 */
export async function scanFolder(folderId: string, auth: OAuth2Client): Promise<ScanResult> {
  const drive = google.drive({ version: "v3", auth });

  const result: ScanResult = { files: [], errors: [] };
  const queue: QueueItem[] = [{ folderId, relativePath: "" }];

  while (queue.length > 0) {
    const { folderId: currentId, relativePath } = queue.shift()!;

    let children: drive_v3.Schema$File[];
    try {
      children = await listChildren(drive, currentId);
    } catch (err) {
      result.errors.push({
        fileId: currentId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const child of children) {
      const name = child.name ?? child.id ?? "unknown";
      const childPath = relativePath ? `${relativePath}/${name}` : name;

      if (child.mimeType === FOLDER_MIME_TYPE) {
        queue.push({ folderId: child.id!, relativePath: childPath });
        continue;
      }

      if (child.mimeType?.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
        result.errors.push({
          fileId: child.id ?? "unknown",
          message: `Skipped "${childPath}": native Google Docs/Sheets/Slides files are not supported yet (export not implemented).`,
        });
        continue;
      }

      if (!child.id || child.size === undefined || child.size === null) {
        result.errors.push({
          fileId: child.id ?? "unknown",
          message: `Skipped "${childPath}": missing id or size.`,
        });
        continue;
      }

      result.files.push({
        id: child.id,
        name,
        relativePath: childPath,
        sizeBytes: Number(child.size),
        mimeType: child.mimeType ?? "application/octet-stream",
      });
    }
  }

  return result;
}
