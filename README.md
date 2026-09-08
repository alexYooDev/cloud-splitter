# CloudSplitter

Stream large Google Drive folders directly to disk as split ZIP parts — no intermediate copy of the original files, no single ZIP that outgrows a FAT32 drive or a flaky connection.

## Why

Downloading a 50GB+ folder through the native Drive web UI often fails to zip, or the connection drops partway through and you lose the whole thing. CloudSplitter streams each file from the Drive API straight into a ZIP part on disk, and once a part hits your chosen size limit (e.g. 3.9GB for FAT32), it closes that ZIP's central directory and starts the next one — so completed parts stay valid even if a later part fails.

## Status

Auth, folder scanning, split planning, and the streaming download engine are all implemented and covered by unit tests.

| Command | Status |
|---|---|
| `auth` | ✅ working |
| `scan` | ✅ working |
| `plan` | ✅ working |
| `download` | ✅ working |

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with a Google Cloud OAuth client (Desktop app type, Drive API enabled):

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

## Usage

Run any command with `npm run dev -- <command>` (or `npm run build && npm start -- <command>` for the compiled version).

```bash
# Authenticate once — opens a local server to catch the OAuth redirect,
# caches the token at ~/.cloudsplitter/token.json
npm run dev -- auth

# List every file under a Drive folder, with sizes and relative paths
npm run dev -- scan -f <folder-id>

# Preview how a folder would be split into ZIP parts, without downloading
npm run dev -- plan -f <folder-id> -s 4000

# Stream the folder down as split ZIP parts (resumable — rerun to pick up
# where a failed download left off)
npm run dev -- download -f <folder-id> -o ./downloads -s 4000
```

## Project structure

```
src/
  core/        # Download/zip logic — no CLI or UI dependencies.
               # Talks outward only through ProgressEmitter events, so a
               # future Electron/Tauri GUI can reuse it without changes.
    types.ts       # CloudFile, ScanResult, ZipPlanPart, SplitOptions
    events.ts      # ProgressEmitter — typed progress events
    auth.ts        # Google OAuth 2.0 (Express-based localhost redirect)
    scanner.ts      # Recursive Drive folder walk -> flat file list
    binpacker.ts    # Sequential bin-packing into size-bounded ZIP parts
    downloader.ts   # Streaming download + ZIP-split engine
    *.test.ts       # Vitest unit tests, colocated with the module they cover
  cli/
    index.ts        # commander entry point
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build        # compile to dist/
npm run dev          # run the CLI from source via tsx
npm test             # run the unit test suite once
npm run test:watch   # run tests in watch mode
```

## Testing

Unit tests mock the Google API client (`vi.mock("googleapis")`) so they run offline, with no real Drive folder or OAuth credentials needed. `downloader.test.ts` streams fake data through the real `archiver`/filesystem pipeline and reads the resulting ZIPs back with `yauzl` to verify byte-exact contents, correct split boundaries, oversized-file handling, resumability (rerunning skips completed parts), and that a mid-part failure leaves no stray `.tmp` file behind while earlier completed parts stay intact.
