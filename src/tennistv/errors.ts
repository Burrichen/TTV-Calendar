/**
 * Structured provider errors.
 *
 * Callers need to distinguish "Tennis TV is briefly unwell" (retry, leave state alone)
 * from "Tennis TV has changed shape" (stop, tell a human). A bare `Error` cannot carry
 * that distinction, and a sync that cannot tell the two apart will eventually treat a
 * schema change as a transient blip and quietly stop working.
 *
 * Every error keeps the request context needed to reproduce it. None of them ever
 * carries a credential, because the provider does not use one.
 */

export type TennisTvErrorCode =
  'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK' | 'INVALID_JSON' | 'SCHEMA_MISMATCH';

export interface TennisTvErrorContext {
  /** The request path, without the host — enough to reproduce, short enough to log. */
  readonly path: string;
  readonly attempts?: number;
}

export abstract class TennisTvError extends Error {
  abstract readonly code: TennisTvErrorCode;
  readonly path: string;
  readonly attempts: number;

  protected constructor(message: string, context: TennisTvErrorContext, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.path = context.path;
    this.attempts = context.attempts ?? 1;
  }

  /**
   * Whether trying again could plausibly succeed.
   *
   * A schema mismatch is deliberately not retryable: repeating a request that returns
   * a shape we do not understand only wastes Tennis TV's capacity.
   */
  abstract get retryable(): boolean;
}

export class TennisTvHttpError extends TennisTvError {
  override readonly name = 'TennisTvHttpError';
  readonly code = 'HTTP_ERROR';
  readonly status: number;
  /** Seconds the server asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    context: TennisTvErrorContext & { retryAfterSeconds?: number | null; body?: string },
  ) {
    const body = context.body === undefined ? '' : ` body=${truncate(context.body, 200)}`;
    super(`Tennis TV returned HTTP ${status} for ${context.path}${body}`, context);
    this.status = status;
    this.retryAfterSeconds = context.retryAfterSeconds ?? null;
  }

  override get retryable(): boolean {
    // 429 and 5xx are worth another go; 4xx means we asked wrongly and will again.
    return this.status === 429 || this.status >= 500;
  }
}

export class TennisTvTimeoutError extends TennisTvError {
  override readonly name = 'TennisTvTimeoutError';
  readonly code = 'TIMEOUT';

  constructor(timeoutMs: number, context: TennisTvErrorContext, cause?: unknown) {
    super(`Tennis TV request to ${context.path} timed out after ${timeoutMs}ms`, context, cause);
  }

  override get retryable(): boolean {
    return true;
  }
}

export class TennisTvNetworkError extends TennisTvError {
  override readonly name = 'TennisTvNetworkError';
  readonly code = 'NETWORK';

  constructor(context: TennisTvErrorContext, cause: unknown) {
    super(`Tennis TV request to ${context.path} failed: ${describeCause(cause)}`, context, cause);
  }

  override get retryable(): boolean {
    return true;
  }
}

export class TennisTvInvalidJsonError extends TennisTvError {
  override readonly name = 'TennisTvInvalidJsonError';
  readonly code = 'INVALID_JSON';

  constructor(context: TennisTvErrorContext & { body: string }, cause?: unknown) {
    super(
      `Tennis TV returned unparseable JSON for ${context.path}: ${truncate(context.body, 200)}`,
      context,
      cause,
    );
  }

  override get retryable(): boolean {
    // A truncated response can be transient; a permanently wrong content type is not,
    // but the retry budget is small enough that trying is cheap.
    return true;
  }
}

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The response parsed as JSON but did not match what the provider understands.
 *
 * The message is written for whoever is woken up by it: what we asked for, what was
 * wrong, how much of the payload was affected, and what to do next.
 */
export class TennisTvSchemaError extends TennisTvError {
  override readonly name = 'TennisTvSchemaError';
  readonly code = 'SCHEMA_MISMATCH';
  readonly issues: readonly SchemaIssue[];
  readonly rejected: number;
  readonly total: number;

  constructor(
    context: TennisTvErrorContext & {
      what: string;
      issues: readonly SchemaIssue[];
      rejected: number;
      total: number;
      sample?: unknown;
    },
  ) {
    const issueList = context.issues
      .slice(0, 5)
      .map((issue) => `    - ${issue.path || '(root)'}: ${issue.message}`)
      .join('\n');
    const more = context.issues.length > 5 ? `\n    …and ${context.issues.length - 5} more` : '';
    const sample =
      context.sample === undefined
        ? ''
        : `\n  Example record: ${truncate(JSON.stringify(context.sample), 400)}`;

    super(
      `Tennis TV ${context.what} no longer matches the expected shape.\n` +
        `  Request: ${context.path}\n` +
        `  Rejected ${context.rejected} of ${context.total} record(s).\n` +
        `  Problems:\n${issueList}${more}${sample}\n` +
        '  Next: run `npm run recon` to re-capture fixtures, then update\n' +
        '  src/tennistv/schemas.ts and src/tennistv/mapper.ts. See docs/TENNISTV_DATA_SOURCE.md.',
      context,
    );

    this.issues = context.issues;
    this.rejected = context.rejected;
    this.total = context.total;
  }

  override get retryable(): boolean {
    // Asking again cannot change the shape of the answer.
    return false;
  }
}

export const isTennisTvError = (error: unknown): error is TennisTvError =>
  error instanceof TennisTvError;

/** True when the error is worth another attempt. Unknown errors are not retried. */
export const isRetryable = (error: unknown): boolean => isTennisTvError(error) && error.retryable;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === undefined ? cause.message : `${code} ${cause.message}`;
  }
  return typeof cause === 'string' ? cause : JSON.stringify(cause);
}
