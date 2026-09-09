import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../../src/core/providers/onedrive/auth.js";

describe("getAccessToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails fast with a clear message when the client id is missing", async () => {
    vi.stubEnv("MICROSOFT_CLIENT_ID", "");

    await expect(getAccessToken()).rejects.toThrow(/MICROSOFT_CLIENT_ID/);
  });
});
