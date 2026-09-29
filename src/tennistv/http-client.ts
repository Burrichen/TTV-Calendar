/**
 * The HTTP layer for the Tennis TV provider.
 *
 * Owns timeouts, retries, backoff and politeness. It knows the host and the
 * `account-id` header; it knows nothing about tournaments or matches.
 *
 * Access is covered by the approval recorded in PROJECT_SPEC.md §2, which comes with
 * an obligation to stay low-volume: an honest User-Agent, a small retry budget, and
 * backoff that respects `Retry-After`.
 */

import {
  TennisTvHttpError,
  TennisTvInvalidJsonError,
  TennisTvNetworkError,
  TennisTvTimeoutError,
  isRetryable,
} from './errors.ts';
import type { Logger } from '../logging/types.ts';

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly accountId: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injectable so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface JsonResponse {
  readonly path: string;
  readonly body: unknown;
  readonly fetchedAt: Date;
  readonly attempts: number;
  readonly durationMs: number;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxAttempts: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
} as const;

const USER_AGENT = 'TTVCalendarBot/0.1 (internal QA scheduling tool; authorised by Tennis TV)';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TennisTvHttpClient {
  readonly #baseUrl: string;
  readonly #accountId: string;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#accountId = options.accountId;
    this.#logger = options.logger.child({ component: 'tennistv-http' });
    this.#timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.#maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Fetches a path and parses it as JSON, retrying transient failures.
   *
   * Throws a `TennisTvError` subclass and nothing else, so callers can branch on
   * `retryable` rather than pattern-matching on messages.
   */
  async getJson(path: string): Promise<JsonResponse> {
    const started = performance.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const body = await this.#attempt(path, attempt);
        return {
          path,
          body,
          fetchedAt: new Date(),
          attempts: attempt,
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        lastError = error;

        if (!isRetryable(error) || attempt === this.#maxAttempts) break;

        const delay = this.#backoffFor(attempt, error);
        this.#logger.warn(
          { path, attempt, maxAttempts: this.#maxAttempts, delayMs: delay, err: error },
          'Tennis TV request failed, retrying',
        );
        await this.#sleep(delay);
      }
    }

    // The final error was constructed on the last attempt, so it already carries the
    // correct attempt count and the server's own explanation. Rebuilding it here would
    // only lose the response body.
    throw lastError;
  }

  async #attempt(path: string, attempt: number): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const context = { path, attempts: attempt };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'account-id': this.#accountId,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) throw new TennisTvTimeoutError(this.#timeoutMs, context, error);
      throw new TennisTvNetworkError(context, error);
    }

    if (!response.ok) {
      throw new TennisTvHttpError(response.status, {
        ...context,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
        body: await response.text().catch(() => ''),
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The body can fail mid-stream after a successful status line.
      throw new TennisTvNetworkError(context, error);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new TennisTvInvalidJsonError({ ...context, body: text }, error);
    }
  }

  /** Exponential backoff with full jitter, overridden by an explicit `Retry-After`. */
  #backoffFor(attempt: number, error: unknown): number {
    if (error instanceof TennisTvHttpError && error.retryAfterSeconds !== null) {
      return Math.min(error.retryAfterSeconds * 1000, this.#maxBackoffMs);
    }
    const ceiling = Math.min(this.#baseBackoffMs * 2 ** (attempt - 1), this.#maxBackoffMs);
    // Full jitter: spreads concurrent retries instead of synchronising them.
    return Math.round(Math.random() * ceiling);
  }
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/** `Retry-After` is either delay-seconds or an HTTP date. Both are worth honouring. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;

  return Math.max(0, Math.round((date - Date.now()) / 1000));
}
