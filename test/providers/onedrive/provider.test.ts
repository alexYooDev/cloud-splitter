import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OneDriveProvider } from "../../../src/core/providers/onedrive/provider.js";

const fetchMock = vi.fn();
const ACCESS_TOKEN = "test-token";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

function makeProvider() {
  return new OneDriveProvider(ACCESS_TOKEN);
}

describe("OneDriveProvider.getItemMetadata", () => {
  it("classifies a file, sends the bearer token, and uses /me/drive/root for the root sentinel", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: "abc123", name: "photo.jpg", size: 4096, file: { mimeType: "image/jpeg" } })
    );

    const item = await makeProvider().getItemMetadata("root");

    expect(item).toEqual({ id: "abc123", name: "photo.jpg", isFolder: false, sizeBytes: 4096, mimeType: "image/jpeg" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/me/drive/root");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("classifies a folder (no sizeBytes/mimeType)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "f1", name: "Photos", folder: { childCount: 3 } }));

    const item = await makeProvider().getItemMetadata("f1");

    expect(item).toEqual({ id: "f1", name: "Photos", isFolder: true, sizeBytes: undefined, mimeType: undefined });
    expect(fetchMock.mock.calls[0]![0]).toContain("/me/drive/items/f1");
  });
});

describe("OneDriveProvider.listChildren", () => {
  it("follows @odata.nextLink to collect every page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          value: [{ id: "a", name: "a.txt", size: 10, file: {} }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: "b", name: "b.txt", size: 20, file: {} }] }));

    const items = await makeProvider().listChildren("root");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe("https://graph.microsoft.com/v1.0/next-page");
    expect(items.map((i) => i.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("throws with a numeric .status on a non-2xx response (required for retry classification)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: "Too many requests" } }));

    await expect(makeProvider().listChildren("root")).rejects.toMatchObject({ status: 429 });
  });
});

describe("OneDriveProvider.scanTarget", () => {
  it("recursively flattens nested folders into relative paths with exact sizes", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/me/drive/root?")) {
        return jsonResponse(200, { id: "root-id", name: "root", folder: { childCount: 2 } });
      }
      if (url.includes("/me/drive/root/children")) {
        return jsonResponse(200, {
          value: [
            { id: "f1", name: "a.txt", size: 1000, file: { mimeType: "text/plain" } },
            { id: "sub1", name: "Sub", folder: { childCount: 1 } },
          ],
        });
      }
      if (url.includes("/me/drive/items/sub1/children")) {
        return jsonResponse(200, { value: [{ id: "f2", name: "b.txt", size: 2000, file: { mimeType: "text/plain" } }] });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await makeProvider().scanTarget("root");

    expect(result.errors).toEqual([]);
    expect(result.files).toEqual([
      { id: "f1", name: "a.txt", relativePath: "a.txt", sizeBytes: 1000, mimeType: "text/plain" },
      { id: "f2", name: "b.txt", relativePath: "Sub/b.txt", sizeBytes: 2000, mimeType: "text/plain" },
    ]);
  });

  it("returns just that file when the target id points to a plain file, not a folder", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "f1", name: "solo.txt", size: 1234, file: { mimeType: "text/plain" } }));

    const result = await makeProvider().scanTarget("f1");

    expect(result).toEqual({
      files: [{ id: "f1", name: "solo.txt", relativePath: "solo.txt", sizeBytes: 1234, mimeType: "text/plain" }],
      errors: [],
    });
  });

  it("skips a file missing a size with a warning instead of crashing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "f1", name: "no-size.bin", file: {} }));

    const result = await makeProvider().scanTarget("f1");

    expect(result.files).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/no-size\.bin/);
  });

  it("records a folder-listing failure as an error but keeps walking sibling folders", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/me/drive/root?")) {
        return jsonResponse(200, { id: "root-id", name: "root", folder: {} });
      }
      if (url.includes("/me/drive/root/children")) {
        return jsonResponse(200, {
          value: [
            { id: "bad", name: "Broken", folder: {} },
            { id: "good", name: "Good", folder: {} },
          ],
        });
      }
      if (url.includes("/me/drive/items/bad/children")) {
        return jsonResponse(403, { error: { message: "forbidden" } });
      }
      if (url.includes("/me/drive/items/good/children")) {
        return jsonResponse(200, { value: [{ id: "f1", name: "c.txt", size: 5, file: {} }] });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await makeProvider().scanTarget("root");

    expect(result.files.map((f) => f.relativePath)).toEqual(["Good/c.txt"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.fileId).toBe("bad");
  });
});

describe("OneDriveProvider.fetchFileStream", () => {
  it("converts the fetch response body into a Node Readable with the correct content", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello world"));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK", body } as unknown as Response);

    const stream = await makeProvider().fetchFileStream("f1");

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello world");
    expect(fetchMock.mock.calls[0]![0]).toContain("/me/drive/items/f1/content");
  });
});
