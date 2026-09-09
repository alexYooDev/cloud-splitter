import type { CloudProvider } from "../provider.js";
import { getAuthorizedClient as getGoogleClient } from "./google/auth.js";
import { GoogleDriveProvider } from "./google/provider.js";
import { getAccessToken as getOneDriveToken } from "./onedrive/auth.js";
import { OneDriveProvider } from "./onedrive/provider.js";

export type ProviderName = "google" | "onedrive";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google Drive",
  onedrive: "OneDrive",
};

/** Runs the given provider's auth flow (reusing a saved session if possible) and returns a ready CloudProvider. */
export async function getProvider(name: ProviderName): Promise<CloudProvider> {
  switch (name) {
    case "google": {
      const client = await getGoogleClient();
      return new GoogleDriveProvider(client);
    }
    case "onedrive": {
      const accessToken = await getOneDriveToken();
      return new OneDriveProvider(accessToken);
    }
  }
}
