#!/usr/bin/env node
import { Command } from "commander";
import { getAuthorizedClient } from "../core/auth.js";
import { scanTarget } from "../core/scanner.js";
import { planZipParts } from "../core/binpacker.js";
import { CloudDownloader, DownloadCancelledError } from "../core/downloader.js";

const program = new Command();

program
  .name("cloudsplitter")
  .description("Stream large cloud-storage folders to disk as split ZIP parts")
  .version("0.1.0");

program
  .command("auth")
  .description("Authenticate with Google Drive")
  .action(async () => {
    await getAuthorizedClient();
    console.log("Authenticated. Token saved to ~/.cloudsplitter/token.json");
  });

program
  .command("scan")
  .description("List all files under a Google Drive folder (or a single file), with sizes and paths")
  .requiredOption("-f, --id <id>", "Google Drive file or folder ID to scan")
  .action(async (opts: { id: string }) => {
    const client = await getAuthorizedClient();
    const { files, errors } = await scanTarget(opts.id, client);

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
  .requiredOption("-f, --id <id>", "Google Drive file or folder ID to scan")
  .option("-s, --split-size <mb>", "Max size per ZIP part, in MB", "4000")
  .action(async (opts: { id: string; splitSize: string }) => {
    const client = await getAuthorizedClient();
    const { files, errors } = await scanTarget(opts.id, client);

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
  .requiredOption("-f, --id <id>", "Google Drive file or folder ID to download")
  .requiredOption("-o, --output <dir>", "Destination directory for ZIP parts")
  .option("-s, --split-size <mb>", "Max size per ZIP part, in MB", "4000")
  .action(async (opts: { id: string; output: string; splitSize: string }) => {
    const client = await getAuthorizedClient();
    const { files, errors } = await scanTarget(opts.id, client);
    for (const err of errors) {
      console.log(`warning: ${err.message}`);
    }

    const splitSizeBytes = Number(opts.splitSize) * 1024 * 1024;
    const downloader = new CloudDownloader(client, {
      splitSizeBytes,
      destinationDir: opts.output,
    });

    downloader.on("plan:complete", ({ partCount }) => {
      console.log(`Planned ${partCount} part(s)`);
    });
    downloader.on("part:start", ({ partIndex, totalParts }) => {
      console.log(`\nPart ${partIndex}/${totalParts}: starting`);
    });
    downloader.on("file:start", ({ name }) => {
      process.stdout.write(`  ${name} ... `);
    });
    downloader.on("file:complete", () => {
      process.stdout.write("done\n");
    });
    downloader.on("file:retry", ({ message }) => {
      console.log(`\n  ! ${message}`);
    });
    downloader.on("file:warning", ({ message }) => {
      console.log(`  ! ${message}`);
    });
    downloader.on("part:complete", ({ partIndex, sizeBytes, outputPath }) => {
      console.log(`Part ${partIndex} complete: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB -> ${outputPath}`);
    });

    let interruptCount = 0;
    const onSigint = () => {
      interruptCount++;
      if (interruptCount === 1) {
        console.log("\nInterrupting after the current file finishes (press Ctrl+C again to force quit)...");
        downloader.cancel();
      } else {
        console.log("\nForce quitting — the in-progress part's .tmp file may be left behind, but is safely ignored on the next run.");
        process.exit(130);
      }
    };
    process.on("SIGINT", onSigint);

    try {
      await downloader.run(files);
      console.log("\nDownload complete.");
    } catch (err) {
      if (err instanceof DownloadCancelledError) {
        console.log("\nInterrupted. Completed parts are saved in place — rerun this same command to resume.");
        process.exitCode = 130;
        return;
      }
      throw err;
    } finally {
      process.off("SIGINT", onSigint);
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
