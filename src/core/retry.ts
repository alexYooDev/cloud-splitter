const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  response?: { status?: unknown };
}

/** True for errors worth retrying: HTTP 429/5xx (googleapis exposes this as .status or .response.status) or common transient network error codes. */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrorLike;

  const status = typeof e.status === "number" ? e.status : typeof e.response?.status === "number" ? e.response.status : undefined;
  if (status !== undefined && TRANSIENT_HTTP_STATUSES.has(status)) return true;

  if (typeof e.code === "string" && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  if (typeof e.code === "number" && TRANSIENT_HTTP_STATUSES.has(e.code)) return true;

  return false;
}

export interface RetryOptions {
  /** Total attempts including the first, not additional retries. Default 5. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  /** Called after a retryable failure, before the backoff wait, with the attempt number about to be tried next. */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
  /** Checked after a retryable failure; if true, the error is rethrown immediately instead of waiting and retrying. */
  shouldAbort?: () => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Equal-jitter exponential backoff: half the exponential delay, plus a random amount up to the other half. */
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 10_000,
    isRetryable = isTransientError,
    onRetry,
    shouldAbort,
  } = options;

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err) || shouldAbort?.()) {
        throw err;
      }
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
