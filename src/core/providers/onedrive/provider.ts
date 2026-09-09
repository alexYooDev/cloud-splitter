import { Readable } from "node:stream";
import type { CloudItem, CloudProvider } from "../../provider.js";
import type { CloudFile, ScanResult } from "../../types.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
}

interface GraphChildrenResponse {
  value: GraphDriveItem[];
  "@odata.nextLink"?: string;
}

interface QueueItem {
  folderId: string;
  relativePath: string;
}

function toCloudItem(item: GraphDriveItem): CloudItem {
  const isFolder = item.folder !== undefined;
  return {
    id: item.id,
    name: item.name,
    isFolder,
    sizeBytes: isFolder ? undefined : item.size,
    mimeType: item.file?.mimeType,
  };
}

/**
 * OneDrive implementation of CloudProvider, via Microsoft Graph REST
 * endpoints and the global fetch — no Graph SDK needed for this narrow,
 * read-only surface. listChildren() is the one "ask Graph for a folder's
 * contents" implementation; scanTarget()'s recursive walk is built on top
 * of it, same pattern as the Google provider.
 */
export class OneDriveProvider implements CloudProvider {
  readonly name = "OneDrive";

  constructor(private readonly accessToken: string) {}

  private async graphFetch(pathOrUrl: string): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });

    if (!res.ok) {
      // fetch doesn't throw on HTTP error statuses — retry.ts's isTransientError
      // classifies on a numeric `.status`, so that must be set explicitly here
      // to keep retry behavior consistent with the Google provider.
      const error = new Error(`Microsoft Graph request failed: ${res.status} ${res.statusText}`) as Error & {
        status: number;
      };
      error.status = res.status;
      throw error;
    }

    return res;
  }

  async getItemMetadata(itemId: string): Promise<CloudItem> {
    const path = itemId === "root" ? "/me/drive/root" : `/me/drive/items/${itemId}`;
    const res = await this.graphFetch(`${path}?$select=id,name,size,file,folder`);
    const data = (await res.json()) as GraphDriveItem;
    return toCloudItem(data);
  }

  async listChildren(folderId: string): Promise<CloudItem[]> {
    const basePath = folderId === "root" ? "/me/drive/root/children" : `/me/drive/items/${folderId}/children`;
    let url: string | undefined = `${basePath}?$select=id,name,size,file,folder&$top=200`;
    const items: CloudItem[] = [];

    while (url) {
      const res = await this.graphFetch(url);
      const data = (await res.json()) as GraphChildrenResponse;
      for (const child of data.value) {
        items.push(toCloudItem(child));
      }
      url = data["@odata.nextLink"];
    }

    return items;
  }

  async scanTarget(targetId: string): Promise<ScanResult> {
    const target = await this.getItemMetadata(targetId);

    if (target.isFolder) {
      return this.walkFolder(targetId);
    }

    if (target.sizeBytes === undefined) {
      return { files: [], errors: [{ fileId: target.id, message: `Skipped "${target.name}": missing size.` }] };
    }

    const file: CloudFile = {
      id: target.id,
      name: target.name,
      relativePath: target.name,
      sizeBytes: target.sizeBytes,
      mimeType: target.mimeType ?? "application/octet-stream",
    };
    return { files: [file], errors: [] };
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

        if (child.isFolder) {
          queue.push({ folderId: child.id, relativePath: childPath });
          continue;
        }

        if (child.sizeBytes === undefined) {
          result.errors.push({ fileId: child.id, message: `Skipped "${childPath}": missing size.` });
          continue;
        }

        result.files.push({
          id: child.id,
          name: child.name,
          relativePath: childPath,
          sizeBytes: child.sizeBytes,
          mimeType: child.mimeType ?? "application/octet-stream",
        });
      }
    }

    return result;
  }

  async fetchFileStream(fileId: string): Promise<Readable> {
    const res = await this.graphFetch(`/me/drive/items/${fileId}/content`);
    if (!res.body) {
      throw new Error(`No response body when fetching file ${fileId}`);
    }
    return Readable.fromWeb(res.body);
  }
}
