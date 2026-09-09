import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransientError, withRetry } from "./retry.js";

describe("isTransientError", () => {
  it.each([
    ["status 429", { status: 429 }],
    ["status 503", { status: 503 }],
    ["response.status 500", { response: { status: 500 } }],
    ["numeric code 502", { code: 502 }],
    ["network code ECONNRESET", { code: "ECONNRESET" }],
    ["network code ETIMEDOUT", { code: "ETIMEDOUT" }],
  ])("treats %s as retryable", (_label, err) => {
    expect(isTransientError(err)).toBe(true);
  });

  it.each([
    ["status 404", { status: 404 }],
    ["status 403", { status: 403 }],
    ["status 401", { status: 401 }],
    ["unrelated code", { code: "SOME_OTHER_CODE" }],
    ["plain Error with no status/code", new Error("boom")],
    ["null", null],
    ["a string", "boom"],
  ])("treats %s as non-retryable", (_label, err) => {
    expect(isTransientError(err)).toBe(false);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result immediately on success, without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds once it stops failing", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const promise = withRetry(fn, { onRetry, baseDelayMs: 10, maxDelayMs: 100 });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 2, maxAttempts: 5 });
    expect(onRetry.mock.calls[1]![0]).toMatchObject({ attempt: 3, maxAttempts: 5 });
  });

  it("gives up and throws once maxAttempts is reached", async () => {
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });
    // Attach a rejection handler immediately so Node doesn't flag this as an
    // unhandled rejection while fake timers are still being advanced below.
    const assertion = expect(promise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error, even on the first attempt", async () => {
    const err = { status: 404 };
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops retrying and rethrows immediately once shouldAbort() is true, without waiting", async () => {
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);
    const shouldAbort = vi.fn().mockReturnValue(true);

    await expect(withRetry(fn, { baseDelayMs: 10, shouldAbort })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldAbort).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially, doubling the delay each retry up to maxDelayMs", async () => {
    const err = { status: 503 };
    const fn = vi.fn().mockRejectedValue(err);
    const onRetry = vi.fn();

    const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, onRetry });
    const assertion = expect(promise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await assertion;

    // Equal-jitter: delay is in [exponential/2, exponential]. Exponential
    // sequence from baseDelayMs=100: 100, 200, 400, 800 (capped at 1000).
    const expectedCeilings = [100, 200, 400, 800];
    expect(onRetry).toHaveBeenCalledTimes(4);
    onRetry.mock.calls.forEach((call, i) => {
      const { delayMs } = call[0] as { delayMs: number };
      expect(delayMs).toBeGreaterThanOrEqual(expectedCeilings[i]! / 2);
      expect(delayMs).toBeLessThanOrEqual(expectedCeilings[i]!);
    });
  });
});
