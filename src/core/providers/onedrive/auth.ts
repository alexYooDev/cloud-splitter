import { PublicClientApplication } from "@azure/msal-node";
import type { Configuration } from "@azure/msal-node";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";

const SCOPES = ["Files.Read", "offline_access"];
const TOKEN_DIR = join(homedir(), ".cloudsplitter");
const CACHE_PATH = join(TOKEN_DIR, "onedrive-token.json");

function loadClientConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  // "consumers" restricts sign-in to personal Microsoft accounts, matching
  // the "Personal Microsoft accounts only" Azure app registration audience.
  const authority = process.env.MICROSOFT_AUTHORITY ?? "https://login.microsoftonline.com/consumers";

  if (!clientId) {
    throw new Error(
      "Missing MICROSOFT_CLIENT_ID. Copy .env.example to .env and fill in your Azure app registration's client ID."
    );
  }

  return { clientId, authority };
}

async function loadCache(pca: PublicClientApplication): Promise<void> {
  try {
    const raw = await readFile(CACHE_PATH, "utf-8");
    pca.getTokenCache().deserialize(raw);
  } catch {
    // No cache yet — first run.
  }
}

async function saveCache(pca: PublicClientApplication): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(CACHE_PATH, pca.getTokenCache().serialize(), "utf-8");
}

/**
 * Runs the interactive OAuth 2.0 flow via MSAL's built-in loopback server —
 * unlike the Google flow, we don't need to run our own Express server here;
 * acquireTokenInteractive spins one up itself on a dynamically chosen port
 * and waits for the redirect.
 */
async function runLoginFlow(pca: PublicClientApplication): Promise<string> {
  const result = await pca.acquireTokenInteractive({
    scopes: SCOPES,
    openBrowser: async (url) => {
      console.log("Open this URL to authorize CloudSplitter:\n");
      console.log(url, "\n");
    },
  });
  return result.accessToken;
}

/**
 * Returns a valid OneDrive access token, reusing a saved session (refreshed
 * silently if needed) and running the interactive login flow otherwise.
 */
export async function getAccessToken(): Promise<string> {
  const { clientId, authority } = loadClientConfig();
  const config: Configuration = { auth: { clientId, authority } };
  const pca = new PublicClientApplication(config);

  await loadCache(pca);

  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ account: accounts[0]!, scopes: SCOPES });
      await saveCache(pca);
      return result.accessToken;
    } catch {
      // Saved session is no longer valid — fall through to interactive login.
    }
  }

  const accessToken = await runLoginFlow(pca);
  await saveCache(pca);
  return accessToken;
}
