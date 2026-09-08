import { ProgressEmitter } from "./events.js";
import type { CloudFile, SplitOptions } from "./types.js";

/**
 * Streams files from Google Drive directly into split ZIP parts.
 * No file is ever fully written to local disk outside of a ZIP part —
 * each file's HTTP response stream is piped straight into `archiver`.
 *
 * Step 3 implements run(): open Part_N.zip, stream/pipe each planned file
 * into it via archiver, watch the written byte count, and roll over to
 * Part_N+1.zip once the threshold is crossed (closing the previous
 * archive's central directory first so completed parts stay valid even
 * if a later part fails).
 */
export class CloudDownloader extends ProgressEmitter {
  constructor(private readonly options: SplitOptions) {
    super();
  }

  async run(_files: CloudFile[]): Promise<void> {
    throw new Error("Not implemented yet — see Step 3");
  }
}
