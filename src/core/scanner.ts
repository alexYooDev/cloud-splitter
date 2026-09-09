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

type Classified =
  | { kind: "folder"; folderId: string }
  | { kind: "file"; file: CloudFile }
  | { kind: "error"; fileId: string; message: string };

function classify(item: drive_v3.Schema$File, relativePath: string): Classified {
  const name = item.name ?? item.id ?? "unknown";

  if (item.mimeType === FOLDER_MIME_TYPE) {
    return { kind: "folder", folderId: item.id! };
  }

  if (item.mimeType?.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
    return {
      kind: "error",
      fileId: item.id ?? "unknown",
      message: `Skipped "${relativePath}": native Google Docs/Sheets/Slides files are not supported yet (export not implemented).`,
    };
  }

  if (!item.id || item.size === undefined || item.size === null) {
    return { kind: "error", fileId: item.id ?? "unknown", message: `Skipped "${relativePath}": missing id or size.` };
  }

  return {
    kind: "file",
    file: {
      id: item.id,
      name,
      relativePath,
      sizeBytes: Number(item.size),
      mimeType: item.mimeType ?? "application/octet-stream",
    },
  };
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

async function walkFolder(drive: drive_v3.Drive, rootFolderId: string): Promise<ScanResult> {
  const result: ScanResult = { files: [], errors: [] };
  const queue: QueueItem[] = [{ folderId: rootFolderId, relativePath: "" }];

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

/**
 * Resolves a Drive ID to a flat, streamable file list. If the ID is a
 * folder, recursively walks it (paths relative to that folder, exact byte
 * sizes). If it's a single file, returns just that file — same shape,
 * so scanning a lone file and scanning a folder are interchangeable for
 * everything downstream (bin-packing, downloading).
 */
export async function scanTarget(targetId: string, auth: OAuth2Client): Promise<ScanResult> {
  const drive = google.drive({ version: "v3", auth });

  const { data: target } = await drive.files.get({
    fileId: targetId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: true,
  });

  if (target.mimeType === FOLDER_MIME_TYPE) {
    return walkFolder(drive, targetId);
  }

  const classified = classify(target, target.name ?? targetId);
  if (classified.kind === "file") {
    return { files: [classified.file], errors: [] };
  }
  if (classified.kind === "error") {
    return { files: [], errors: [{ fileId: classified.fileId, message: classified.message }] };
  }
  // classify() only returns "folder" for FOLDER_MIME_TYPE, already handled above.
  throw new Error("unreachable");
}
