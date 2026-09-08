#!/usr/bin/env node
import { Command } from "commander";
import { getAuthorizedClient } from "../core/auth.js";
import { scanFolder } from "../core/scanner.js";
import { planZipParts } from "../core/binpacker.js";

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
  .description("List all files under a Google Drive folder, with sizes and paths")
  .requiredOption("-f, --folder-id <id>", "Google Drive folder ID to scan")
  .action(async (opts: { folderId: string }) => {
    const client = await getAuthorizedClient();
    const { files, errors } = await scanFolder(opts.folderId, client);

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
  .description("Scan a folder and preview how it would be split into ZIP parts")
  .requiredOption("-f, --folder-id <id>", "Google Drive folder ID to scan")
  .option("-s, --split-size <mb>", "Max size per ZIP part, in MB", "4000")
  .action(async (opts: { folderId: string; splitSize: string }) => {
    const client = await getAuthorizedClient();
    const { files, errors } = await scanFolder(opts.folderId, client);

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
  .description("Scan a cloud folder and stream it down as split ZIP parts")
  .requiredOption("-f, --folder-id <id>", "Google Drive folder ID to download")
  .requiredOption("-o, --output <dir>", "Destination directory for ZIP parts")
  .option("-s, --split-size <mb>", "Max size per ZIP part, in MB", "4000")
  .action(() => {
    console.error("Not implemented yet — see Step 3");
    process.exitCode = 1;
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
