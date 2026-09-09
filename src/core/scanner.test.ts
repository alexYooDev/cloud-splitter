import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuth2Client } from "google-auth-library";

const filesList = vi.fn();
const filesGet = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    drive: vi.fn(() => ({ files: { list: filesList, get: filesGet } })),
  },
}));

const { scanTarget } = await import("./scanner.js");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const DUMMY_AUTH = {} as OAuth2Client;

function extractFolderId(q: string): string {
  return q.match(/'(.+)' in parents/)![1]!;
}

beforeEach(() => {
  filesList.mockReset();
  filesGet.mockReset();
  // Default: the target id ("root") resolves to a folder, matching the
  // existing folder-walk tests below unless a test overrides this.
  filesGet.mockResolvedValue({ data: { id: "root", name: "root", mimeType: FOLDER_MIME } });
});

describe("scanTarget — folder", () => {
  it("recursively flattens nested folders into relative paths with exact sizes", async () => {
    filesList.mockImplementation(async ({ q }: { q: string }) => {
      const folderId = extractFolderId(q);
      if (folderId === "root") {
        return {
          data: {
            files: [
              { id: "f1", name: "a.txt", mimeType: "text/plain", size: "1000" },
              { id: "sub1", name: "Sub", mimeType: FOLDER_MIME },
            ],
          },
        };
      }
      if (folderId === "sub1") {
        return { data: { files: [{ id: "f2", name: "b.txt", mimeType: "text/plain", size: "2000" }] } };
      }
      throw new Error(`unexpected folder id: ${folderId}`);
    });

    const result = await scanTarget("root", DUMMY_AUTH);

    expect(result.errors).toEqual([]);
    expect(result.files).toEqual([
      { id: "f1", name: "a.txt", relativePath: "a.txt", sizeBytes: 1000, mimeType: "text/plain" },
      { id: "f2", name: "b.txt", relativePath: "Sub/b.txt", sizeBytes: 2000, mimeType: "text/plain" },
    ]);
  });

  it("follows nextPageToken to collect every page within a folder", async () => {
    filesList.mockImplementation(async ({ pageToken }: { pageToken?: string }) => {
      if (!pageToken) {
        return {
          data: {
            files: [{ id: "f1", name: "a.txt", mimeType: "text/plain", size: "10" }],
            nextPageToken: "page2",
          },
        };
      }
      expect(pageToken).toBe("page2");
      return { data: { files: [{ id: "f2", name: "b.txt", mimeType: "text/plain", size: "20" }] } };
    });

    const result = await scanTarget("root", DUMMY_AUTH);

    expect(filesList).toHaveBeenCalledTimes(2);
    expect(result.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("skips native Google Docs/Sheets/Slides with a warning instead of including them", async () => {
    filesList.mockResolvedValue({
      data: {
        files: [
          { id: "f1", name: "a.txt", mimeType: "text/plain", size: "10" },
          { id: "doc1", name: "My Doc", mimeType: DOC_MIME },
        ],
      },
    });

    const result = await scanTarget("root", DUMMY_AUTH);

    expect(result.files).toEqual([
      { id: "f1", name: "a.txt", relativePath: "a.txt", sizeBytes: 10, mimeType: "text/plain" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.fileId).toBe("doc1");
    expect(result.errors[0]!.message).toMatch(/My Doc/);
  });

  it("skips files missing an id or size with a warning", async () => {
    filesList.mockResolvedValue({
      data: {
        files: [
          { id: "f1", name: "a.txt", mimeType: "text/plain", size: "10" },
          { id: "f2", name: "no-size.bin", mimeType: "application/octet-stream" },
        ],
      },
    });

    const result = await scanTarget("root", DUMMY_AUTH);

    expect(result.files).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/no-size\.bin/);
  });

  it("records a folder-listing failure as an error but keeps walking sibling folders", async () => {
    filesList.mockImplementation(async ({ q }: { q: string }) => {
      const folderId = extractFolderId(q);
      if (folderId === "root") {
        return {
          data: {
            files: [
              { id: "bad", name: "Broken", mimeType: FOLDER_MIME },
              { id: "good", name: "Good", mimeType: FOLDER_MIME },
            ],
          },
        };
      }
      if (folderId === "bad") {
        throw new Error("permission denied");
      }
      if (folderId === "good") {
        return { data: { files: [{ id: "f1", name: "c.txt", mimeType: "text/plain", size: "5" }] } };
      }
      throw new Error(`unexpected folder id: ${folderId}`);
    });

    const result = await scanTarget("root", DUMMY_AUTH);

    expect(result.files.map((f) => f.relativePath)).toEqual(["Good/c.txt"]);
    expect(result.errors).toEqual([{ fileId: "bad", message: "permission denied" }]);
  });

  it("returns an empty result for an empty folder", async () => {
    filesList.mockResolvedValue({ data: { files: [] } });
    const result = await scanTarget("root", DUMMY_AUTH);
    expect(result).toEqual({ files: [], errors: [] });
  });
});

describe("scanTarget — single file", () => {
  it("returns just that file when the id points to a plain file, not a folder", async () => {
    filesGet.mockResolvedValue({ data: { id: "f1", name: "solo.txt", mimeType: "text/plain", size: "1234" } });

    const result = await scanTarget("f1", DUMMY_AUTH);

    expect(result).toEqual({
      files: [{ id: "f1", name: "solo.txt", relativePath: "solo.txt", sizeBytes: 1234, mimeType: "text/plain" }],
      errors: [],
    });
    expect(filesList).not.toHaveBeenCalled();
  });

  it("returns an error instead of a file when the single target is a native Google Doc", async () => {
    filesGet.mockResolvedValue({ data: { id: "doc1", name: "My Doc", mimeType: DOC_MIME } });

    const result = await scanTarget("doc1", DUMMY_AUTH);

    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([
      {
        fileId: "doc1",
        message: 'Skipped "My Doc": native Google Docs/Sheets/Slides files are not supported yet (export not implemented).',
      },
    ]);
  });

  it("returns an error instead of a file when the single target is missing a size", async () => {
    filesGet.mockResolvedValue({ data: { id: "f1", name: "no-size.bin", mimeType: "application/octet-stream" } });

    const result = await scanTarget("f1", DUMMY_AUTH);

    expect(result.files).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/no-size\.bin/);
  });
});
