import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import express from "express";
import "dotenv/config";

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
const TOKEN_DIR = join(homedir(), ".cloudsplitter");
const TOKEN_PATH = join(TOKEN_DIR, "token.json");

function loadClientConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/oauth2callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Copy .env.example to .env and fill in your OAuth client credentials."
    );
  }

  return { clientId, clientSecret, redirectUri };
}

async function loadSavedTokens(client: OAuth2Client): Promise<boolean> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf-8");
    client.setCredentials(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

async function saveTokens(client: OAuth2Client): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(client.credentials, null, 2), "utf-8");
}

/** Runs the interactive OAuth 2.0 localhost-redirect flow and returns the granted tokens. */
function runLoginFlow(client: OAuth2Client, redirectUri: string): Promise<void> {
  const { port, pathname } = new URL(redirectUri);

  return new Promise((resolve, reject) => {
    const app = express();

    app.get(pathname, (req, res) => {
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;

      if (oauthError) {
        res.status(400).type("text/plain").send(`Authorization failed: ${oauthError}`);
        server.close();
        reject(new Error(`Google OAuth error: ${oauthError}`));
        return;
      }

      if (!code) {
        res.status(400).type("text/plain").send("Missing authorization code");
        return;
      }

      client
        .getToken(code)
        .then(({ tokens }) => {
          client.setCredentials(tokens);
          res.status(200).type("text/plain").send("Authorized. You can close this tab.");
          server.close();
          resolve();
        })
        .catch((err) => {
          res.status(500).type("text/plain").send("Token exchange failed.");
          server.close();
          reject(err);
        });
    });

    const server = app.listen(Number(port), () => {
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });
      console.log("Open this URL to authorize CloudSplitter:\n");
      console.log(authUrl, "\n");
    });

    server.on("error", reject);
  });
}

/**
 * Returns an authenticated OAuth2Client, reusing a saved token if one exists
 * and running the interactive login flow otherwise.
 */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret, redirectUri } = loadClientConfig();
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const hasSavedTokens = await loadSavedTokens(client);
  if (hasSavedTokens) {
    return client;
  }

  await runLoginFlow(client, redirectUri);
  await saveTokens(client);
  return client;
}
