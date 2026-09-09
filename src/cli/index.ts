#!/usr/bin/env node
import { Command } from "commander";
import cliProgress from "cli-progress";
import { getProvider, type ProviderName } from "../core/providers/index.js";
import type { CloudProvider } from "../core/provider.js";
import { planZipParts } from "../core/binpacker.js";
import { CloudDownloader, DownloadCancelledError } from "../core/downloader.js";
import { pickProvider, pickTarget, InteractiveCancelledError } from "./interactive.js";

const program = new Command();

program
  .name("cloudsplitter")
  .description("Stream large cloud-storage folders to disk as split ZIP parts")
  .version("0.1.0");

function assertProviderName(value: string): asserts value is ProviderName {
  if (value !== "google" && value !== "onedrive") {
    throw new Error(`Unknown provider "${value}". Expected "google" or "onedrive".`);
  }
}

async function resolveProvider(providerOpt: string | undefined): Promise<CloudProvider> {
  let name: ProviderName;
  if (providerOpt) {
    assertProviderName(providerOpt);
    name = providerOpt;
  } else {
    name = await pickProvider();
  }
  return getProvider(name);
}

/** Resolves a ready CloudProvider and target id, prompting interactively for whatever wasn't passed as a flag. */
async function resolveProviderAndTarget(opts: {
  provider?: string;
  id?: string;
}): Promise<{ provider: CloudProvider; id: string }> {
  const provider = await resolveProvider(opts.provider);
  const id = opts.id ?? (await pickTarget(provider)).id;
  return { provider, id };
}

program
  .command("auth")
  .description("Authenticate with a cloud provider")
  .option("-p, --provider <name>", "Cloud provider: google or onedrive")
  .action(async (opts: { provider?: string }) => {
    const provider = await resolveProvider(opts.provider);
    console.log(`Authenticated with ${provider.name}.`);
  });

program
  .command("scan")
  .description("List all files under a cloud folder (or a single file), with sizes and paths")
  .option("-p, --provider <name>", "Cloud provider: google or onedrive")
  .option("-f, --id <id>", "File or folder ID to scan (omit to browse interactively)")
  .action(async (opts: { provider?: string; id?: string }) => {
    const { provider, id } = await resolveProviderAndTarget(opts);
    const { files, errors } = await provider.scanTarget(id);

    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    for (const file of files) {
      console.log(`${(file.sizeBytes / 1024 / 1024).toFixed(2).padStart(10)} MB  ${file.relativePath}`);
    }
    console.log(`\n${files.length} files, ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB total`);

    if (errors.length > 0) {
      console.log(`\n${errors.length} warning(s):`);
      for (const err of errors) {
        console.log(`  - ${err.message}`);
      }
    }
  });

program
  .command("plan")
  .description("Scan a folder or file and preview how it would be split into ZIP parts")
  .option("-p, --provider <name>", "Cloud provider: google or onedrive")
  .option("-f, --id <id>", "File or folder ID to scan (omit to browse interactively)")
  .option("-s, --split-size <mb>", "Max size per ZIP part, in MB", "4000")
  .action(async (opts: { provider?: string; id?: string; splitSize: string }) => {
    const { provider, id } = await resolveProviderAndTarget(opts);
    const { files, errors } = await provider.scanTarget(id);

    const splitSizeBytes = Number(opts.splitSize) * 1024 * 1024;
    const parts = planZipParts(files, { splitSizeBytes, destinationDir: "" });

    for (const part of parts) {
      const sizeMb = (part.totalSizeBytes / 1024 / 1024).toFixed(2);
      const label = part.isOversizedStandalone ? " (oversized, standalone)" : "";
      console.log(`Part_${String(part.partIndex).padStart(2, "0")}.zip — ${sizeMb} MB, ${part.files.length} file(s)${label}`);
      if (part.isOversizedStandalone) {
        console.log(`  ! "${part.files[0]!.relativePath}" exceeds the split size on its own`);
      }
    }
    console.log(`\n${parts.length} part(s) planned from ${files.length} file(s)`);

    if (errors.length > 0) {
      console.log(`\n${errors.length} warning(s) from scan:`);
      for (const err of errors) {
        console.log(`  - ${err.message}`);
      }
    }
  });

program
  .command("download")
  .description("Scan a cloud folder or file and stream it down as split ZIP parts")
  .option("-p, --provider <name>", "Cloud provider: google or onedrive")
  .option("-f, --id <id>", "File or folder ID to download (omit to browse interactively)")
  .requiredOption("-o, --output <dir>", "Destination directory for ZIP parts")
  .option("-s, --split-size <mb>", "Max size per ZIP part, in MB", "4000")
  .action(async (opts: { provider?: string; id?: string; output: string; splitSize: string }) => {
    const { provider, id } = await resolveProviderAndTarget(opts);
    const { files, errors } = await provider.scanTarget(id);
    for (const err of errors) {
      console.log(`warning: ${err.message}`);
    }

    const splitSizeBytes = Number(opts.splitSize) * 1024 * 1024;
    const downloader = new CloudDownloader(provider, {
      splitSizeBytes,
      destinationDir: opts.output,
    });

    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    const multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        emptyOnZero: true,
        // We drive our own SIGINT handling below (letting the in-flight file
        // finish before stopping); cli-progress's built-in SIGINT handler
        // would race it, so it's disabled and we call multibar.stop()
        // ourselves in every exit path instead.
        gracefulExit: false,
        format: " {bar} | {percentage}% | {value}/{total} | {label}",
      },
      cliProgress.Presets.shades_classic
    );
    const overallBar = multibar.create(totalBytes, 0, { label: "Overall" });
    let currentFileBar: import("cli-progress").SingleBar | null = null;
    let completedBytes = 0;
    let stopped = false;
    const stopBars = () => {
      if (stopped) return;
      stopped = true;
      multibar.stop();
    };

    downloader.on("plan:complete", ({ partCount }) => {
      multibar.log(`Planned ${partCount} part(s)\n`);
    });
    downloader.on("part:start", ({ partIndex, totalParts }) => {
      multibar.log(`\nPart ${partIndex}/${totalParts}: starting\n`);
    });
    downloader.on("file:start", ({ name, fileId }) => {
      const file = files.find((f) => f.id === fileId);
      currentFileBar = multibar.create(file?.sizeBytes ?? 0, 0, { label: name });
    });
    downloader.on("file:progress", ({ bytesWritten }) => {
      currentFileBar?.update(bytesWritten);
      overallBar.update(completedBytes + bytesWritten);
    });
    downloader.on("file:complete", ({ fileId }) => {
      const file = files.find((f) => f.id === fileId);
      completedBytes += file?.sizeBytes ?? 0;
      overallBar.update(completedBytes);
      if (currentFileBar) {
        multibar.remove(currentFileBar);
        currentFileBar = null;
      }
    });
    downloader.on("file:retry", ({ message }) => {
      multibar.log(`  ! ${message}\n`);
    });
    downloader.on("file:warning", ({ message }) => {
      multibar.log(`  ! ${message}\n`);
    });
    downloader.on("part:complete", ({ partIndex, sizeBytes, outputPath }) => {
      multibar.log(`Part ${partIndex} complete: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB -> ${outputPath}\n`);
    });

    let interruptCount = 0;
    const onSigint = () => {
      interruptCount++;
      if (interruptCount === 1) {
        multibar.log("\nInterrupting after the current file finishes (press Ctrl+C again to force quit)...\n");
        downloader.cancel();
      } else {
        stopBars();
        console.log("\nForce quitting — the in-progress part's .tmp file may be left behind, but is safely ignored on the next run.");
        process.exit(130);
      }
    };
    process.on("SIGINT", onSigint);

    try {
      await downloader.run(files);
      stopBars();
      console.log("\nDownload complete.");
    } catch (err) {
      stopBars();
      if (err instanceof DownloadCancelledError) {
        console.log("\nInterrupted. Completed parts are saved in place — rerun this same command to resume.");
        process.exitCode = 130;
        return;
      }
      throw err;
    } finally {
      process.off("SIGINT", onSigint);
      stopBars();
    }
  });

program.parseAsync().catch((err) => {
  if (err instanceof InteractiveCancelledError) {
    process.exitCode = 1;
    return;
  }
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
