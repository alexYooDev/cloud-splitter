import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthorizedClient } from "./auth.js";

describe("getAuthorizedClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails fast with a clear message when OAuth client credentials are missing", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");

    await expect(getAuthorizedClient()).rejects.toThrow(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/);
  });

  it("fails fast when only the client secret is missing", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "some-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");

    await expect(getAuthorizedClient()).rejects.toThrow(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/);
  });
});
