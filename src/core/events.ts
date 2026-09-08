import { EventEmitter } from "node:events";

/**
 * Typed progress events emitted by the core download/zip engine.
 * The CLI (Phase 1) and a future Electron/Tauri GUI (Phase 2) both
 * subscribe to this instead of depending on each other.
 */
export interface ProgressEvents {
  "scan:start": [{ folderId: string }];
  "scan:complete": [{ fileCount: number; totalBytes: number }];
  "plan:complete": [{ partCount: number }];
  "part:start": [{ partIndex: number; totalParts: number }];
  "part:complete": [{ partIndex: number; sizeBytes: number; outputPath: string }];
  "file:start": [{ fileId: string; name: string; partIndex: number }];
  "file:progress": [{ fileId: string; bytesWritten: number; totalBytes: number }];
  "file:complete": [{ fileId: string }];
  "file:warning": [{ fileId: string; message: string }];
  error: [Error];
}

export class ProgressEmitter extends EventEmitter {
  override emit<K extends keyof ProgressEvents>(event: K, ...args: ProgressEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ProgressEvents>(
    event: K,
    listener: (...args: ProgressEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
