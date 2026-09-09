import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudItem, CloudProvider } from "../../src/core/provider.js";

const selectMock = vi.fn();
const CANCEL_SYMBOL = Symbol("cancel");

vi.mock("@clack/prompts", () => ({
  select: (...args: unknown[]) => selectMock(...args),
  isCancel: (value: unknown) => value === CANCEL_SYMBOL,
  cancel: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

const { pickTarget, pickProvider, InteractiveCancelledError } = await import("../../src/cli/interactive.js");

function mkItem(id: string, name: string, isFolder: boolean, sizeBytes?: number): CloudItem {
  return { id, name, isFolder, sizeBytes };
}

function makeFakeProvider(childrenByFolder: Record<string, CloudItem[]>): CloudProvider {
  return {
    name: "Test Drive",
    listChildren: vi.fn(async (folderId: string) => childrenByFolder[folderId] ?? []),
    getItemMetadata: vi.fn(),
    scanTarget: vi.fn(),
    fetchFileStream: vi.fn(),
  };
}

beforeEach(() => {
  selectMock.mockReset();
});

describe("pickTarget", () => {
  it("descends into a selected folder and returns a selected file", async () => {
    const provider = makeFakeProvider({
      root: [mkItem("sub1", "Sub", true), mkItem("f1", "a.txt", false, 100)],
      sub1: [mkItem("f2", "b.txt", false, 200)],
    });
    selectMock.mockResolvedValueOnce("sub1").mockResolvedValueOnce("f2");

    const result = await pickTarget(provider);

    expect(result).toEqual({ id: "f2", name: "b.txt" });
    expect(provider.listChildren).toHaveBeenNthCalledWith(1, "root");
    expect(provider.listChildren).toHaveBeenNthCalledWith(2, "sub1");
  });

  it("returns the current folder when 'use this folder' is selected", async () => {
    const provider = makeFakeProvider({ root: [mkItem("f1", "a.txt", false, 100)] });
    selectMock.mockResolvedValueOnce("__use_folder__");

    const result = await pickTarget(provider);

    expect(result).toEqual({ id: "root", name: "Test Drive" });
  });

  it("'back' returns to the previous folder without losing navigation state", async () => {
    const provider = makeFakeProvider({
      root: [mkItem("sub1", "Sub", true)],
      sub1: [mkItem("f1", "a.txt", false, 100)],
    });
    selectMock
      .mockResolvedValueOnce("sub1") // descend into Sub
      .mockResolvedValueOnce("__back__") // back to root
      .mockResolvedValueOnce("__use_folder__"); // use root

    const result = await pickTarget(provider);

    expect(result).toEqual({ id: "root", name: "Test Drive" });
    expect(provider.listChildren).toHaveBeenCalledTimes(3); // root, sub1, root again
  });

  it("throws InteractiveCancelledError when the user cancels", async () => {
    const provider = makeFakeProvider({ root: [] });
    selectMock.mockResolvedValueOnce(CANCEL_SYMBOL);

    await expect(pickTarget(provider)).rejects.toThrow(InteractiveCancelledError);
  });

  it("does not offer a 'back' option at the root level", async () => {
    const provider = makeFakeProvider({ root: [] });
    selectMock.mockImplementationOnce(async (opts: { options: { value: string }[] }) => {
      expect(opts.options.some((o) => o.value === "__back__")).toBe(false);
      return "__use_folder__";
    });

    await pickTarget(provider);
  });

  it("offers a 'back' option once inside a subfolder", async () => {
    const provider = makeFakeProvider({
      root: [mkItem("sub1", "Sub", true)],
      sub1: [],
    });
    selectMock.mockResolvedValueOnce("sub1");
    selectMock.mockImplementationOnce(async (opts: { options: { value: string }[] }) => {
      expect(opts.options.some((o) => o.value === "__back__")).toBe(true);
      return "__use_folder__";
    });

    await pickTarget(provider);
  });
});

describe("pickProvider", () => {
  it("returns the selected provider name", async () => {
    selectMock.mockResolvedValueOnce("onedrive");
    await expect(pickProvider()).resolves.toBe("onedrive");
  });

  it("throws InteractiveCancelledError when cancelled", async () => {
    selectMock.mockResolvedValueOnce(CANCEL_SYMBOL);
    await expect(pickProvider()).rejects.toThrow(InteractiveCancelledError);
  });
});
