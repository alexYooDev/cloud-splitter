# CloudSplitter

Stream large Google Drive or OneDrive folders directly to disk as split ZIP parts — no intermediate copy of the original files, no single ZIP that outgrows a FAT32 drive or a flaky connection.

## Why

Downloading a 50GB+ folder through the native web UI often fails to zip, or the connection drops partway through and you lose the whole thing. CloudSplitter streams each file from the cloud provider's API straight into a ZIP part on disk, and once a part hits your chosen size limit (e.g. 3.9GB for FAT32), it closes that ZIP's central directory and starts the next one — so completed parts stay valid even if a later part fails. A transient failure fetching one file (rate limiting, a dropped connection) is retried with exponential backoff before giving up.

## Status

Both providers (Google Drive, OneDrive), folder scanning, split planning, and the streaming download engine are all implemented and covered by unit tests.

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

### Google Drive

Fill in `.env` with a Google Cloud OAuth client (Desktop app type, Drive API enabled):

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

### OneDrive

1. Go to [portal.azure.com](https://portal.azure.com/) → **App registrations → New registration**.
2. Supported account types: **Personal Microsoft accounts only** (or the broader "any organizational directory and personal Microsoft accounts" option if you also want work/school support — see `MICROSOFT_AUTHORITY` below).
3. Under **Authentication → Add a platform → Mobile and desktop applications**, add the redirect URI `http://localhost` (exactly that, no port — CloudSplitter's login flow picks a free port on each run and Azure matches any port against a bare `http://localhost` entry for this platform type).
4. Under **API permissions**, add the delegated Microsoft Graph permission `Files.Read`.
5. Copy the **Application (client) ID** from the registration's Overview page into `.env`:

```
MICROSOFT_CLIENT_ID=
```

If you registered for work/school accounts too, set `MICROSOFT_AUTHORITY=https://login.microsoftonline.com/common` in `.env` (default is personal-accounts-only).

## Usage

Run any command with `npm run dev -- <command>` (or `npm run build && npm start -- <command>` for the compiled version).

Omit `-p/--provider` and `-f/--id` and CloudSplitter asks interactively: pick a provider, then browse your actual folder tree (arrow keys, Enter to descend/select) to pick a target — no need to hunt down a file/folder ID yourself. Pass both flags to skip the prompts entirely (for scripting).

```bash
# Authenticate with a provider once — token is cached, so this only asks again
# if it expires or is revoked
npm run dev -- auth                        # prompts for a provider
npm run dev -- auth -p google              # skip the prompt
npm run dev -- auth -p onedrive

# List every file under a folder (or just one file), with sizes and paths
npm run dev -- scan                        # browse interactively
npm run dev -- scan -p google -f <id>      # or specify directly

# Preview how it would be split into ZIP parts, without downloading
npm run dev -- plan -s 4000

# Stream it down as split ZIP parts, with a live overall + per-file
# progress bar. Resumable — rerun to pick up where a failed download
# left off. Press Ctrl+C to stop gracefully: the file currently in
# flight finishes, its part is safely discarded, and rerunning the
# same command resumes from the last completed part.
npm run dev -- download -o ./downloads -s 4000
```

## Project structure

```
src/
  core/        # Download/zip logic — no CLI or UI dependencies.
               # Talks outward only through ProgressEmitter events, so a
               # future Electron/Tauri GUI can reuse it without changes.
    provider.ts     # CloudProvider interface — the one seam between this
                     # logic and provider-specific auth/API details
    providers/
      google/         # Google Drive: OAuth (Express localhost redirect),
                       # GoogleDriveProvider (googleapis-based)
      onedrive/        # OneDrive: OAuth (MSAL's built-in loopback flow),
                       # OneDriveProvider (Microsoft Graph REST via fetch)
      index.ts        # getProvider(name) factory
    types.ts       # CloudFile, ScanResult, ZipPlanPart, SplitOptions
    events.ts      # ProgressEmitter — typed progress events
    binpacker.ts    # Sequential bin-packing into size-bounded ZIP parts
    downloader.ts   # Streaming download + ZIP-split engine (provider-agnostic)
    retry.ts        # Exponential backoff for transient API failures
  cli/
    index.ts        # commander entry point
    interactive.ts   # Provider/folder picker (@clack/prompts) — CLI-only,
                     # core/ stays UI-agnostic
test/
  core/          # Vitest unit tests for provider-agnostic logic
  providers/     # Unit tests per provider (mocked googleapis / fetch)
  cli/           # Interactive picker navigation tests (mocked @clack/prompts)
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

Tests live under `test/`, mirroring `src/`'s structure, and import the source they cover by relative path (e.g. `test/core/downloader.test.ts` imports `../../src/core/downloader.js`). They all run offline, with no real cloud account, OAuth credentials, or Azure app registration needed:

- `test/core/downloader.test.ts` constructs a plain fake `CloudProvider` object (no provider-specific mocking at all) and streams fake data through the real `archiver`/filesystem pipeline, reading the resulting ZIPs back with `yauzl` to verify byte-exact contents, correct split boundaries, oversized-file handling, resumability (rerunning skips completed parts), retry/backoff behavior, and that a mid-part failure or cancellation leaves no stray `.tmp` file behind while earlier completed parts stay intact.
- `test/providers/google/` mocks `googleapis`; `test/providers/onedrive/` mocks the global `fetch` — both cover folder-vs-file classification, pagination, and (for OneDrive) that a non-2xx Graph response is thrown with a numeric `.status` so `retry.ts`'s transient-error classification works the same for both providers.
- `test/cli/interactive.test.ts` mocks `@clack/prompts` to test the folder browser's descend/back/select navigation logic against a fake provider, independent of real terminal rendering.

`npm run typecheck` uses `tsconfig.test.json` (which extends the base config to also include `test/**/*`) so both source and tests get typechecked, while `npm run build` still uses the base `tsconfig.json` scoped to `src/` only — keeping `dist/` free of test output.
