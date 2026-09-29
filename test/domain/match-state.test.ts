import { describe, expect, it } from 'vitest';

import { detectStateChange, isPending } from '../../src/domain/match-state.ts';
import { MATCH_STATUSES, type MatchStatus } from '../../src/domain/types.ts';

/**
 * Every alert the bot will ever send is decided by `detectStateChange`, so this covers
 * the whole transition matrix rather than a few happy paths.
 *
 * The matrix itself is PROJECT_SPEC.md §6.3.
 */

const AT_14 = new Date('2026-09-15T13:00:00Z');
const AT_15 = new Date('2026-09-15T14:00:00Z');

/** A state with a published start time unless told otherwise. */
const state = (status: MatchStatus, startsAtUtc: Date | null = AT_14) => ({
  status,
  startsAtUtc,
});

describe('detectStateChange', () => {
  describe('transitions that alert', () => {
    it('announces a scheduled match going live', () => {
      const change = detectStateChange(state('SCHEDULED'), state('LIVE'));

      expect(change?.transition).toBe('LIVE');
      expect(change?.from).toBe('SCHEDULED');
      expect(change?.to).toBe('LIVE');
    });

    it('announces a delayed match resuming', () => {
      // Explicitly required: a resumed match is news.
      const change = detectStateChange(state('DELAYED'), state('LIVE'));

      expect(change?.transition).toBe('LIVE');
      expect(change?.from).toBe('DELAYED');
    });

    it('announces a delay before play', () => {
      expect(detectStateChange(state('SCHEDULED'), state('DELAYED'))?.transition).toBe('DELAYED');
    });

    it('announces a suspension during play', () => {
      expect(detectStateChange(state('LIVE'), state('DELAYED'))?.transition).toBe('DELAYED');
    });

    it.each(['SCHEDULED', 'DELAYED', 'LIVE'] as const)(
      'announces a cancellation from %s',
      (from) => {
        expect(detectStateChange(state(from), state('CANCELLED'))?.transition).toBe('CANCELLED');
      },
    );

    it('carries the start times across a delay, for the message', () => {
      const change = detectStateChange(state('SCHEDULED', AT_14), state('DELAYED', AT_15));

      expect(change?.previousStartsAtUtc).toEqual(AT_14);
      expect(change?.newStartsAtUtc).toEqual(AT_15);
    });
  });

  describe('repeated observations stay silent', () => {
    it.each(MATCH_STATUSES)('says nothing when %s is observed again', (status) => {
      expect(detectStateChange(state(status), state(status))).toBeNull();
    });

    it('says nothing for LIVE to LIVE', () => {
      // The restart case: the process comes back and re-observes a live match.
      expect(detectStateChange(state('LIVE'), state('LIVE'))).toBeNull();
    });

    it('says nothing for DELAYED to DELAYED', () => {
      expect(detectStateChange(state('DELAYED'), state('DELAYED'))).toBeNull();
    });
  });

  describe('transitions that must stay silent', () => {
    it('does not announce completion', () => {
      expect(detectStateChange(state('LIVE'), state('COMPLETED'))).toBeNull();
    });

    it.each(['CANCELLED', 'COMPLETED'] as const)('treats %s as terminal', (from) => {
      for (const to of MATCH_STATUSES) {
        expect(detectStateChange(state(from), state(to))).toBeNull();
      }
    });
  });

  describe('UNKNOWN is inert in both directions', () => {
    it.each(MATCH_STATUSES)('never announces a move from %s into UNKNOWN', (from) => {
      // An unrecognised provider code must never look like a cancellation.
      expect(detectStateChange(state(from), state('UNKNOWN'))).toBeNull();
    });

    it.each(MATCH_STATUSES)('never announces a move out of UNKNOWN into %s', (to) => {
      // Recovering from an unmapped code must not replay a transition that already
      // happened while we could not read it.
      expect(detectStateChange(state('UNKNOWN'), state(to))).toBeNull();
    });

    it('stays silent when the provider is unreadable from the first sighting', () => {
      expect(detectStateChange(null, state('UNKNOWN'))).toBeNull();
    });
  });

  describe('first sighting', () => {
    it('announces a match first seen already live', () => {
      const change = detectStateChange(null, state('LIVE'));

      expect(change?.transition).toBe('LIVE');
      expect(change?.from).toBe('SCHEDULED');
    });

    it.each(['SCHEDULED', 'DELAYED', 'CANCELLED', 'COMPLETED'] as const)(
      'stays silent for a match first seen as %s',
      (status) => {
        // Learning that a match exists is not news; only it starting is.
        expect(detectStateChange(null, state(status))).toBeNull();
      },
    );
  });

  describe('a published start time moving later', () => {
    it('is treated as a delay', () => {
      // Tennis TV republishing the match an hour later, without labelling it.
      const change = detectStateChange(state('SCHEDULED', AT_14), state('SCHEDULED', AT_15));

      expect(change?.transition).toBe('DELAYED');
      expect(change?.previousStartsAtUtc).toEqual(AT_14);
      expect(change?.newStartsAtUtc).toEqual(AT_15);
    });

    it('ignores a move smaller than the threshold', () => {
      const fiveLater = new Date(AT_14.getTime() + 5 * 60_000);
      expect(
        detectStateChange(state('SCHEDULED', AT_14), state('SCHEDULED', fiveLater)),
      ).toBeNull();
    });

    it('honours a configured threshold', () => {
      const twentyLater = new Date(AT_14.getTime() + 20 * 60_000);

      expect(
        detectStateChange(state('SCHEDULED', AT_14), state('SCHEDULED', twentyLater), {
          scheduleSlipMinutes: 30,
        }),
      ).toBeNull();
      expect(
        detectStateChange(state('SCHEDULED', AT_14), state('SCHEDULED', twentyLater), {
          scheduleSlipMinutes: 10,
        })?.transition,
      ).toBe('DELAYED');
    });

    it('ignores a match brought forward — that is not a delay', () => {
      expect(detectStateChange(state('SCHEDULED', AT_15), state('SCHEDULED', AT_14))).toBeNull();
    });

    it('ignores a Time TBC match, which has nothing to compare', () => {
      expect(detectStateChange(state('SCHEDULED', null), state('SCHEDULED', AT_15))).toBeNull();
      expect(detectStateChange(state('SCHEDULED', AT_14), state('SCHEDULED', null))).toBeNull();
    });

    it('does not apply once a match is live', () => {
      // A live match's start time changing is data tidying, not a delay.
      expect(detectStateChange(state('LIVE', AT_14), state('LIVE', AT_15))).toBeNull();
    });

    it('never fires from time merely passing', () => {
      // Same observation twice, hours after the start: nothing changed, so nothing is
      // announced. The clock is never consulted here (PROJECT_SPEC.md §6.4).
      const longAgo = new Date('2020-01-01T00:00:00Z');
      expect(
        detectStateChange(state('SCHEDULED', longAgo), state('SCHEDULED', longAgo)),
      ).toBeNull();
    });
  });

  it('only ever emits a notifiable transition', () => {
    const notifiable = new Set<MatchStatus>(['LIVE', 'DELAYED', 'CANCELLED']);

    for (const from of [...MATCH_STATUSES, null]) {
      for (const to of MATCH_STATUSES) {
        const change = detectStateChange(from === null ? null : state(from), state(to));
        if (change !== null) {
          expect(notifiable.has(change.transition)).toBe(true);
          expect(change.to).toBe(change.transition);
        }
      }
    }
  });

  it('is a pure function — the same inputs always give the same answer', () => {
    const first = detectStateChange(state('SCHEDULED'), state('LIVE'));
    const second = detectStateChange(state('SCHEDULED'), state('LIVE'));
    expect(first).toEqual(second);
  });
});

describe('isPending', () => {
  it.each(['SCHEDULED', 'DELAYED', 'LIVE'] as const)('keeps watching a %s match', (status) => {
    expect(isPending(status)).toBe(true);
  });

  it.each(['CANCELLED', 'COMPLETED'] as const)('stops watching a %s match', (status) => {
    expect(isPending(status)).toBe(false);
  });

  it('keeps watching an UNKNOWN match', () => {
    // Unknown is not evidence that a match has finished.
    expect(isPending('UNKNOWN')).toBe(true);
  });
});
