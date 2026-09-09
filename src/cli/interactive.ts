import * as clack from "@clack/prompts";
import type { CloudItem, CloudProvider } from "../core/provider.js";
import { PROVIDER_LABELS, type ProviderName } from "../core/providers/index.js";

/** Thrown when the user cancels an interactive prompt (Ctrl+C / Esc). */
export class InteractiveCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "InteractiveCancelledError";
  }
}

function checkCancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new InteractiveCancelledError();
  }
  // isCancel's type guard is on `unknown`, so TS can't narrow a generic T | symbol
  // on its own here — safe because isCancel already ruled out the symbol case.
  return value as T;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]!}`;
}

export async function pickProvider(): Promise<ProviderName> {
  const choice = await clack.select<ProviderName>({
    message: "Which cloud storage do you want to use?",
    options: [
      { value: "google", label: PROVIDER_LABELS.google },
      { value: "onedrive", label: PROVIDER_LABELS.onedrive },
    ],
  });
  return checkCancel(choice);
}

// A folder browser is for navigating to a target, not hand-picking one of
// thousands of files — cap the rendered list so a huge folder stays usable.
const MAX_LISTED_ITEMS = 200;
const USE_FOLDER = "__use_folder__";
const BACK = "__back__";

interface Frame {
  folderId: string;
  name: string;
}

/**
 * Interactively browses a provider's folder tree, starting at its root, and
 * returns the id/name of whatever the user selects — a folder (via the
 * explicit "use this folder" option) or a file.
 */
export async function pickTarget(provider: CloudProvider): Promise<{ id: string; name: string }> {
  const stack: Frame[] = [{ folderId: "root", name: provider.name }];

  for (;;) {
    const current = stack[stack.length - 1]!;

    const spin = clack.spinner();
    spin.start(`Loading ${current.name}...`);
    let children: CloudItem[];
    try {
      children = await provider.listChildren(current.folderId);
    } finally {
      spin.stop();
    }

    const truncated = children.length > MAX_LISTED_ITEMS;
    const shown = truncated ? children.slice(0, MAX_LISTED_ITEMS) : children;

    const options: { value: string; label: string; hint?: string }[] = [
      { value: USE_FOLDER, label: `✓ Use "${current.name}"`, hint: "download everything in this folder" },
    ];
    if (stack.length > 1) {
      options.push({ value: BACK, label: "‹ Back" });
    }
    for (const item of shown) {
      options.push({
        value: item.id,
        label: `${item.isFolder ? "📁" : "📄"} ${item.name}`,
        hint: item.isFolder ? undefined : formatSize(item.sizeBytes ?? 0),
      });
    }

    const message = truncated
      ? `${current.name} (showing first ${MAX_LISTED_ITEMS} of ${children.length} items)`
      : current.name;

    const choice = checkCancel(await clack.select<string>({ message, options }));

    if (choice === USE_FOLDER) {
      return { id: current.folderId, name: current.name };
    }
    if (choice === BACK) {
      stack.pop();
      continue;
    }

    const picked = shown.find((item) => item.id === choice)!;
    if (picked.isFolder) {
      stack.push({ folderId: picked.id, name: picked.name });
      continue;
    }
    return { id: picked.id, name: picked.name };
  }
}
