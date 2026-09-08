import { describe, expect, it } from "vitest";
import { planZipParts } from "./binpacker.js";
import type { CloudFile } from "./types.js";

function mkFile(name: string, mb: number): CloudFile {
  return { id: name, name, relativePath: name, sizeBytes: mb * 1024 * 1024, mimeType: "application/octet-stream" };
}

const SPLIT_BYTES = 100 * 1024 * 1024;

describe("planZipParts", () => {
  it("fills each part greedily in scan order without reordering", () => {
    const files = [mkFile("a", 40), mkFile("b", 40), mkFile("c", 40), mkFile("d", 10)];
    const parts = planZipParts(files, { splitSizeBytes: SPLIT_BYTES, destinationDir: "" });

    expect(parts).toHaveLength(2);
    expect(parts[0]!.files.map((f) => f.name)).toEqual(["a", "b"]);
    expect(parts[0]!.totalSizeBytes).toBe(80 * 1024 * 1024);
    expect(parts[1]!.files.map((f) => f.name)).toEqual(["c", "d"]);
    expect(parts[1]!.totalSizeBytes).toBe(50 * 1024 * 1024);
  });

  it("isolates an oversized file into its own standalone part without disrupting neighbors", () => {
    const files = [mkFile("a", 40), mkFile("huge", 250), mkFile("b", 40), mkFile("c", 40)];
    const parts = planZipParts(files, { splitSizeBytes: SPLIT_BYTES, destinationDir: "" });

    expect(parts.map((p) => p.files.map((f) => f.name))).toEqual([["a"], ["huge"], ["b", "c"]]);
    expect(parts[1]!.isOversizedStandalone).toBe(true);
    expect(parts[0]!.isOversizedStandalone).toBe(false);
    expect(parts[2]!.isOversizedStandalone).toBe(false);
  });

  it("returns no parts for empty input", () => {
    expect(planZipParts([], { splitSizeBytes: SPLIT_BYTES, destinationDir: "" })).toEqual([]);
  });

  it("packs files that exactly hit the split size into a single part", () => {
    const files = [mkFile("a", 50), mkFile("b", 50)];
    const parts = planZipParts(files, { splitSizeBytes: SPLIT_BYTES, destinationDir: "" });
    expect(parts).toHaveLength(1);
  });

  it("starts a new part as soon as the next file would overflow the current one", () => {
    const files = [mkFile("a", 50), mkFile("b", 51)];
    const parts = planZipParts(files, { splitSizeBytes: SPLIT_BYTES, destinationDir: "" });
    expect(parts.map((p) => p.files.map((f) => f.name))).toEqual([["a"], ["b"]]);
  });

  it("assigns sequential 1-based partIndex values", () => {
    const files = [mkFile("a", 60), mkFile("b", 60), mkFile("c", 60)];
    const parts = planZipParts(files, { splitSizeBytes: SPLIT_BYTES, destinationDir: "" });
    expect(parts.map((p) => p.partIndex)).toEqual([1, 2, 3]);
  });

  it("throws on a non-positive split size", () => {
    expect(() => planZipParts([mkFile("a", 1)], { splitSizeBytes: 0, destinationDir: "" })).toThrow(
      /must be positive/
    );
    expect(() => planZipParts([mkFile("a", 1)], { splitSizeBytes: -1, destinationDir: "" })).toThrow(
      /must be positive/
    );
  });
});
