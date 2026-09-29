/**
 * An in-memory `StateApi`, for testing the jobs without a network.
 *
 * It implements the same contract the real one does — claim-once, takeover of a stale
 * claim, an attempt ceiling, and settle semantics — because the jobs depend on exactly
 * those behaviours. `test/state/contract.test.ts` pins that this implementation matches
 * the behaviour `test/worker/state-api.test.ts` pins for the real SQL one, so the two
 * cannot drift apart silently.
 *
 * Failures are injectable, because "the state API is down" is a case the jobs must
 * handle deliberately rather than accidentally.
 */

import type { CalendarSnapshot, SnapshotVariant } from '../../src/domain/snapshot.ts';
import type {
  ClaimOutcome,
  ClaimRequest,
  MatchStateRecord,
  SettleRequest,
  StateApi,
} from '../../src/state/client.ts';
import { StateApiError } from '../../src/state/client.ts';

/** Matches `CLAIM_STALE_AFTER_MS` in the Worker. */
const CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Notification {
  status: 'PENDING' | 'SENT' | 'SUPPRESSED' | 'ABANDONED';
  attempts: number;
  claimedAt: Date;
  reason?: string | undefined;
  slackTs?: string | null | undefined;
  recipientCount?: number | null | undefined;
}

export class MemoryStateApi implements StateApi {
  readonly subscriberIds = new Map<string, string[]>();
  readonly matchStates = new Map<string, MatchStateRecord>();
  readonly notifications = new Map<string, Notification>();

  /** Set to make every method reject, simulating the Worker being unreachable. */
  failure: Error | null = null;
  /**
   * Method names that should fail while the rest keep working.
   *
   * Models the nastiest real case: Slack accepts a message and *then* the call
   * recording that fact fails, leaving the two sides disagreeing.
   */
  readonly failOn = new Set<string>();
  /** Counts calls, so tests can assert a job does not ask when it need not. */
  readonly calls: string[] = [];

  setSubscribers(channelId: string, userIds: readonly string[]): void {
    this.subscriberIds.set(channelId, [...userIds]);
  }

  subscribers(channelId: string): Promise<readonly string[]> {
    this.#guard('subscribers');
    return Promise.resolve([...(this.subscriberIds.get(channelId) ?? [])].sort());
  }

  loadMatchStates(keys: readonly string[]): Promise<Map<string, MatchStateRecord>> {
    this.#guard('loadMatchStates');
    const found = new Map<string, MatchStateRecord>();
    for (const key of keys) {
      const state = this.matchStates.get(key);
      if (state !== undefined) found.set(key, state);
    }
    return Promise.resolve(found);
  }

  saveMatchStates(states: readonly MatchStateRecord[]): Promise<void> {
    this.#guard('saveMatchStates');
    for (const state of states) this.matchStates.set(state.matchKey, state);
    return Promise.resolve();
  }

  claim(request: ClaimRequest): Promise<ClaimOutcome> {
    this.#guard('claim');
    const existing = this.notifications.get(request.key);

    if (existing === undefined) {
      this.notifications.set(request.key, {
        status: 'PENDING',
        attempts: 1,
        claimedAt: request.now,
      });
      return Promise.resolve({ status: 'claimed', attempts: 1 });
    }

    if (existing.status === 'ABANDONED') {
      return Promise.resolve({ status: 'duplicate', reason: 'abandoned' });
    }

    if (existing.status !== 'PENDING') {
      return Promise.resolve({ status: 'duplicate', reason: 'settled' });
    }

    const stale = request.now.getTime() - existing.claimedAt.getTime() >= CLAIM_STALE_AFTER_MS;
    if (!stale) return Promise.resolve({ status: 'duplicate', reason: 'in-flight' });

    existing.attempts += 1;
    existing.claimedAt = request.now;

    if (existing.attempts > MAX_ATTEMPTS) {
      existing.status = 'ABANDONED';
      return Promise.resolve({ status: 'duplicate', reason: 'abandoned' });
    }

    return Promise.resolve({ status: 'claimed', attempts: existing.attempts });
  }

  settle(request: SettleRequest): Promise<void> {
    this.#guard('settle');
    const existing = this.notifications.get(request.key);
    if (existing === undefined) return Promise.resolve();

    switch (request.outcome) {
      case 'sent':
        existing.status = 'SENT';
        existing.slackTs = request.slackTs ?? null;
        existing.recipientCount = request.recipientCount ?? null;
        break;
      case 'suppressed':
        existing.status = 'SUPPRESSED';
        existing.reason = request.reason;
        break;
      case 'failed':
        // Deliberately stays PENDING so a later run can retry it.
        existing.reason = request.reason;
        break;
      case 'abandoned':
        existing.status = 'ABANDONED';
        existing.reason = request.reason;
        break;
    }

    return Promise.resolve();
  }

  statuses(keys: readonly string[]): Promise<Record<string, string | null>> {
    this.#guard('statuses');
    return Promise.resolve(
      Object.fromEntries(keys.map((key) => [key, this.notifications.get(key)?.status ?? null])),
    );
  }

  /** Keyed the way D1 is, so test snapshots cannot overwrite production ones. */
  readonly snapshots = new Map<string, CalendarSnapshot>();

  saveSnapshot(snapshot: CalendarSnapshot, variant: SnapshotVariant): Promise<void> {
    this.#guard('saveSnapshot');
    this.snapshots.set(`${snapshot.periodKey}|${variant}`, snapshot);
    return Promise.resolve();
  }

  prune(): Promise<{ matches: number; notifications: number }> {
    this.#guard('prune');
    return Promise.resolve({ matches: 0, notifications: 0 });
  }

  /**
   * Marks a key as already delivered.
   *
   * Used to isolate one report in a test: with no history at all, every *catchable*
   * occurrence is outstanding, so a Tuesday run legitimately offers to send this week's
   * weekly report as a catch-up.
   */
  markSent(key: string, at = new Date()): void {
    this.notifications.set(key, { status: 'SENT', attempts: 1, claimedAt: at });
  }

  /** Convenience for assertions: which keys actually reached SENT. */
  sentKeys(): string[] {
    return [...this.notifications.entries()]
      .filter(([, value]) => value.status === 'SENT')
      .map(([key]) => key)
      .sort();
  }

  #guard(method: string): void {
    this.calls.push(method);
    if (this.failure) throw new StateApiError(this.failure.message, null, true);
    if (this.failOn.has(method)) {
      throw new StateApiError(`injected failure in ${method}`, null, true);
    }
  }
}
