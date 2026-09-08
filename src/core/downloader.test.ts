import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yauzl from "yauzl";
import type { OAuth2Client } from "google-auth-library";
import type { CloudFile } from "./types.js";

const filesGet = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    drive: vi.fn(() => ({ files: { get: filesGet } })),
  },
}));

const { CloudDownloader, DownloadCancelledError } = await import("./downloader.js");

const DUMMY_AUTH = {} as OAuth2Client;

function mkFile(id: string, name: string, mb: number): CloudFile {
  return { id, name, relativePath: name, sizeBytes: mb * 1024 * 1024, mimeType: "application/octet-stream" };
}

/** A Readable that yields `sizeBytes` of `fillByte`, in chunks — exercises real streaming, not one buffered blob. */
function fakeStream(sizeBytes: number, fillByte: number): Readable {
  let remaining = sizeBytes;
  return new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      const n = Math.min(64 * 1024, remaining);
      this.push(Buffer.alloc(n, fillByte));
      remaining -= n;
    },
  });
}

async function readZipEntries(path: string) {
  const zipfile = await yauzl.openPromise(path, { lazyEntries: true });
  const results: { name: string; uncompressedSize: number; data: Buffer }[] = [];
  for await (const entry of zipfile.eachEntry()) {
    const stream = await zipfile.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    results.push({ name: entry.fileName, uncompressedSize: entry.uncompressedSize, data: Buffer.concat(chunks) });
  }
  return results;
}

let outDir: string;

beforeEach(async () => {
  filesGet.mockReset();
  outDir = await mkdtemp(join(tmpdir(), "cloudsplitter-test-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

// a+b fits one part (8MB); c alone starts the next (adding it to a+b would hit 12MB > 10MB);
// huge (25MB) exceeds the split size on its own, so it gets isolated as a standalone part;
// d (3MB) starts a fresh part after the standalone.
const SPLIT_BYTES = 10 * 1024 * 1024;
const FILL: Record<string, number> = { f1: 65, f2: 66, f3: 67, f4: 68, f5: 69 };
const FILES = [
  mkFile("f1", "a.bin", 4),
  mkFile("f2", "b.bin", 4),
  mkFile("f3", "c.bin", 4),
  mkFile("f4", "huge.bin", 25),
  mkFile("f5", "d.bin", 3),
];

function mockSuccessfulFetches(files: CloudFile[]) {
  filesGet.mockImplementation(async ({ fileId }: { fileId: string }) => {
    const file = files.find((f) => f.id === fileId)!;
    return { data: fakeStream(file.sizeBytes, FILL[fileId]!) };
  });
}

describe("CloudDownloader", () => {
  it("splits files into byte-exact ZIP parts and warns on an oversized standalone file", async () => {
    mockSuccessfulFetches(FILES);
    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });

    const warnings: string[] = [];
    downloader.on("file:warning", ({ message }) => warnings.push(message));

    await downloader.run(FILES);

    expect(await readdir(outDir)).toEqual(
      expect.arrayContaining(["Part_01.zip", "Part_02.zip", "Part_03.zip", "Part_04.zip"])
    );

    const part1 = await readZipEntries(join(outDir, "Part_01.zip"));
    expect(part1.map((e) => e.name)).toEqual(["a.bin", "b.bin"]);
    expect(part1[0]!.data.equals(Buffer.alloc(4 * 1024 * 1024, FILL.f1))).toBe(true);
    expect(part1[1]!.data.equals(Buffer.alloc(4 * 1024 * 1024, FILL.f2))).toBe(true);

    const part2 = await readZipEntries(join(outDir, "Part_02.zip"));
    expect(part2.map((e) => e.name)).toEqual(["c.bin"]);

    const part3 = await readZipEntries(join(outDir, "Part_03.zip"));
    expect(part3.map((e) => e.name)).toEqual(["huge.bin"]);
    expect(part3[0]!.uncompressedSize).toBe(25 * 1024 * 1024);
    expect(part3[0]!.data.equals(Buffer.alloc(25 * 1024 * 1024, FILL.f4))).toBe(true);

    const part4 = await readZipEntries(join(outDir, "Part_04.zip"));
    expect(part4.map((e) => e.name)).toEqual(["d.bin"]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/huge\.bin/);
    expect(warnings[0]).toMatch(/Part_03\.zip/);
  });

  it("skips parts that already completed on a previous run instead of re-fetching them", async () => {
    mockSuccessfulFetches(FILES);
    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });
    await downloader.run(FILES);

    const fetchCountAfterFirstRun = filesGet.mock.calls.length;
    const partStarts: number[] = [];

    const resumedDownloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });
    resumedDownloader.on("part:start", ({ partIndex }) => partStarts.push(partIndex));
    await resumedDownloader.run(FILES);

    expect(filesGet.mock.calls.length).toBe(fetchCountAfterFirstRun);
    expect(partStarts).toEqual([]);
  });

  it("on a mid-part failure, leaves prior completed parts intact and no stray .tmp file behind", async () => {
    // part1 = [a, b] succeeds; part2 = [c] fails on its only file.
    filesGet.mockImplementation(async ({ fileId }: { fileId: string }) => {
      if (fileId === "f3") throw new Error("simulated network failure");
      const file = FILES.find((f) => f.id === fileId)!;
      return { data: fakeStream(file.sizeBytes, FILL[fileId]!) };
    });

    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });

    await expect(downloader.run(FILES)).rejects.toThrow(/simulated network failure/);

    const entries = await readdir(outDir);
    expect(entries).toContain("Part_01.zip");
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const part1 = await readZipEntries(join(outDir, "Part_01.zip"));
    expect(part1.map((e) => e.name)).toEqual(["a.bin", "b.bin"]);
  });

  it("cancel() before run() starts stops before fetching anything", async () => {
    mockSuccessfulFetches(FILES);
    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });
    downloader.cancel();

    await expect(downloader.run(FILES)).rejects.toThrow(DownloadCancelledError);
    expect(filesGet).not.toHaveBeenCalled();
  });

  it("cancel() after a part completes stops before the next part, keeping the finished part", async () => {
    mockSuccessfulFetches(FILES);
    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });
    downloader.on("part:complete", ({ partIndex }) => {
      if (partIndex === 1) downloader.cancel();
    });

    await expect(downloader.run(FILES)).rejects.toThrow(DownloadCancelledError);

    const entries = await readdir(outDir);
    expect(entries).toEqual(["Part_01.zip"]);
    expect(filesGet).not.toHaveBeenCalledWith(expect.objectContaining({ fileId: "f3" }), expect.anything());
  });

  it("cancel() mid-part lets the in-flight file finish, then discards the whole part (no stray .tmp, current file's fetch not repeated)", async () => {
    mockSuccessfulFetches(FILES);
    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });
    downloader.on("file:complete", ({ fileId }) => {
      if (fileId === "f1") downloader.cancel();
    });

    await expect(downloader.run(FILES)).rejects.toThrow(DownloadCancelledError);

    const entries = await readdir(outDir);
    expect(entries).toEqual([]);
    expect(filesGet).toHaveBeenCalledTimes(1);
    expect(filesGet).toHaveBeenCalledWith({ fileId: "f1", alt: "media" }, { responseType: "stream" });
  });

  it("does not emit an 'error' event for a cancellation", async () => {
    mockSuccessfulFetches(FILES);
    const downloader = new CloudDownloader(DUMMY_AUTH, { splitSizeBytes: SPLIT_BYTES, destinationDir: outDir });
    downloader.cancel();

    const errorListener = vi.fn();
    downloader.on("error", errorListener);

    await expect(downloader.run(FILES)).rejects.toThrow(DownloadCancelledError);
    expect(errorListener).not.toHaveBeenCalled();
  });
});
