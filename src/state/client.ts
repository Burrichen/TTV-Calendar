/**
 * The Node application's view of the state it cannot recompute.
 *
 * A GitHub Actions runner is destroyed after every execution, so the three questions
 * this client answers — who is opted in, what did this match look like last time, and
 * have we already sent this — are answered by the Cloudflare Worker's D1 database over
 * HTTPS (docs/ARCHITECTURE.md §16).
 *
 * Two design points carry real weight:
 *
 *  - **`StateApi` is an interface, not a class.** The jobs depend on the interface, so
 *    the whole application is testable against an in-memory implementation with no
 *    network, and the HTTP client is tested separately.
 *  - **A failure here is never silently read as "nothing".** Treating an unreachable
 *    database as "no claim exists" would send duplicates, and as "no subscribers" would
 *    silently drop alerts. Every method throws instead, and the caller decides.
 */

import type { CalendarSnapshot, SnapshotVariant } from '../domain/snapshot.ts';
import type { MatchStatus } from '../domain/types.ts';

/** What a previous run observed for one match. */
export interface MatchStateRecord {
  readonly matchKey: string;
  readonly tournamentKey: string;
  readonly status: MatchStatus;
  readonly startsAtUtc: Date | null;
  readonly observedAt: Date;
}

export type NotificationKind = 'ALERT' | 'REPORT';

export type ClaimOutcome =
  /** The claim is ours. `attempts` is 1 on the first try, higher on a retry. */
  | { readonly status: 'claimed'; readonly attempts: number }
  /** Already sent, held by a live claim, or given up on. Send nothing. */
  | { readonly status: 'duplicate'; readonly reason: string };

export interface ClaimRequest {
  readonly key: string;
  readonly kind: NotificationKind;
  readonly reference: string;
  readonly now: Date;
}

export type SettleOutcome = 'sent' | 'suppressed' | 'failed' | 'abandoned';

export interface SettleRequest {
  readonly key: string;
  readonly outcome: SettleOutcome;
  readonly now: Date;
  readonly slackTs?: string | null;
  readonly recipientCount?: number | null;
  readonly reason?: string;
}

export interface StateApi {
  /** Slack user IDs currently opted in to alerts in `channelId`. */
  subscribers(channelId: string): Promise<readonly string[]>;
  /** Previous state for the given match keys. Absent keys are simply not returned. */
  loadMatchStates(keys: readonly string[]): Promise<Map<string, MatchStateRecord>>;
  /** Records what this run observed. */
  saveMatchStates(states: readonly MatchStateRecord[], now: Date): Promise<void>;
  /** Attempts to become the sender of one idempotency key. */
  claim(request: ClaimRequest): Promise<ClaimOutcome>;
  /** Records the fate of a claim. */
  settle(request: SettleRequest): Promise<void>;
  /** Current status of several keys, or null where never claimed. */
  statuses(keys: readonly string[]): Promise<Record<string, string | null>>;
  /** Stores a calendar snapshot for the modals to render. */
  saveSnapshot(snapshot: CalendarSnapshot, variant: SnapshotVariant): Promise<void>;
  /** Retention sweep. */
  prune(before: Date): Promise<{ matches: number; notifications: number }>;
}

/** Thrown for anything the state API could not do. Never swallowed into a default. */
export class StateApiError extends Error {
  override readonly name = 'StateApiError';
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export interface HttpStateApiOptions {
  /** Base URL of the Worker, e.g. `https://ttv-calendar-bot.example.workers.dev`. */
  readonly baseUrl: string;
  /** Shared secret, presented as a bearer token. Never logged. */
  readonly secret: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  /** Injectable for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class HttpStateApi implements StateApi {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HttpStateApiOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async subscribers(channelId: string): Promise<readonly string[]> {
    const body = await this.#request<{ userIds: string[] }>(
      'GET',
      `/api/subscribers?channel=${encodeURIComponent(channelId)}`,
    );
    return body.userIds;
  }

  async loadMatchStates(keys: readonly string[]): Promise<Map<string, MatchStateRecord>> {
    const states = new Map<string, MatchStateRecord>();
    if (keys.length === 0) return states;

    // Chunked to stay well inside the API's per-request cap and SQLite's bound
    // parameter limit on the other side.
    for (const chunk of chunked(keys, 200)) {
      const body = await this.#request<{ states: RawMatchState[] }>(
        'POST',
        '/api/match-state/load',
        { keys: chunk },
      );

      for (const raw of body.states) {
        states.set(raw.matchKey, {
          matchKey: raw.matchKey,
          tournamentKey: raw.tournamentKey,
          status: raw.status as MatchStatus,
          startsAtUtc: raw.startsAtUtc === null ? null : new Date(raw.startsAtUtc),
          observedAt: new Date(raw.observedAt),
        });
      }
    }

    return states;
  }

  async saveMatchStates(states: readonly MatchStateRecord[], now: Date): Promise<void> {
    if (states.length === 0) return;

    for (const chunk of chunked(states, 200)) {
      await this.#request('POST', '/api/match-state/save', {
        now: now.toISOString(),
        states: chunk.map((state) => ({
          matchKey: state.matchKey,
          tournamentKey: state.tournamentKey,
          status: state.status,
          startsAtUtc: state.startsAtUtc?.toISOString() ?? null,
          observedAt: state.observedAt.toISOString(),
        })),
      });
    }
  }

  claim(request: ClaimRequest): Promise<ClaimOutcome> {
    return this.#request<ClaimOutcome>('POST', '/api/notifications/claim', {
      key: request.key,
      kind: request.kind,
      reference: request.reference,
      now: request.now.toISOString(),
    });
  }

  async settle(request: SettleRequest): Promise<void> {
    await this.#request('POST', '/api/notifications/settle', {
      key: request.key,
      outcome: request.outcome,
      now: request.now.toISOString(),
      slackTs: request.slackTs ?? null,
      recipientCount: request.recipientCount ?? null,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
  }

  async statuses(keys: readonly string[]): Promise<Record<string, string | null>> {
    if (keys.length === 0) return {};
    const body = await this.#request<{ statuses: Record<string, string | null> }>(
      'POST',
      '/api/notifications/status',
      { keys },
    );
    return body.statuses;
  }

  async saveSnapshot(snapshot: CalendarSnapshot, variant: SnapshotVariant): Promise<void> {
    await this.#request('POST', '/api/snapshots/save', { variant, snapshot });
  }

  prune(before: Date): Promise<{ matches: number; notifications: number }> {
    return this.#request('POST', '/api/maintenance/prune', { before: before.toISOString() });
  }

  /**
   * One API call, with bounded retries for transient failures.
   *
   * Only network errors, timeouts and 5xx are retried. A 400 or 401 is a configuration
   * problem that retrying would merely delay, and a 404 means the endpoint or the
   * secret is wrong.
   */
  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: StateApiError | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#attempt<T>(method, path, body);
      } catch (error) {
        if (!(error instanceof StateApiError) || !error.retryable) throw error;

        lastError = error;
        if (attempt === this.#maxAttempts) break;
        await this.#sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
      }
    }

    throw lastError ?? new StateApiError(`state API ${method} ${path} failed`, null, true);
  }

  async #attempt<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#secret}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new StateApiError(
        // The URL is safe to name; the secret is in a header and never appears here.
        `state API unreachable (${method} ${path}): ${timedOut ? 'timed out' : 'network error'}`,
        null,
        true,
      );
    }

    if (!response.ok) {
      throw new StateApiError(
        `state API returned ${String(response.status)} for ${method} ${path}`,
        response.status,
        response.status >= 500,
      );
    }

    return (await response.json()) as T;
  }
}

interface RawMatchState {
  readonly matchKey: string;
  readonly tournamentKey: string;
  readonly status: string;
  readonly startsAtUtc: string | null;
  readonly observedAt: string;
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
