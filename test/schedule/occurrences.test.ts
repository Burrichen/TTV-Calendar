import { describe, expect, it } from 'vitest';

import {
  CRON_EXPRESSIONS,
  dueOccurrences,
  isDue,
  isWithinGrace,
  occurrenceFor,
} from '../../src/schedule/occurrences.ts';

/**
 * The occurrence model is pure, so every scheduling question — DST, catch-up, a Monday
 * that is also the 1st — is answered by choosing an instant. No timers, no clock
 * mocking, no waiting.
 *
 * 2026 UK transitions: BST starts Sunday 29 March, ends Sunday 25 October.
 */

const OPTIONS = { timezone: 'Europe/London' };
const at = (iso: string): Date => new Date(iso);

describe('daily occurrences', () => {
  it('is due at 08:00 GMT in winter, which is 08:00 UTC', () => {
    const occurrence = occurrenceFor('DAILY', at('2026-01-15T12:00:00Z'), OPTIONS);

    expect(occurrence.occurrenceDate).toBe('2026-01-15');
    expect(occurrence.dueAt.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(occurrence.window).toEqual({ from: '2026-01-15', to: '2026-01-15' });
  });

  it('is due at 08:00 BST in summer, which is 07:00 UTC', () => {
    // The hour shifts because the zone does — no offset is computed anywhere.
    const occurrence = occurrenceFor('DAILY', at('2026-08-15T12:00:00Z'), OPTIONS);

    expect(occurrence.dueAt.toISOString()).toBe('2026-08-15T07:00:00.000Z');
  });

  it('belongs to the local day, not the UTC day', () => {
    // 23:30 UTC in August is already the next day in London.
    const occurrence = occurrenceFor('DAILY', at('2026-08-14T23:30:00Z'), OPTIONS);
    expect(occurrence.occurrenceDate).toBe('2026-08-15');
  });

  it('is catchable until the end of its local day', () => {
    const occurrence = occurrenceFor('DAILY', at('2026-01-15T12:00:00Z'), OPTIONS);

    expect(isWithinGrace(occurrence, at('2026-01-15T23:59:00Z'))).toBe(true);
    expect(isWithinGrace(occurrence, at('2026-01-16T00:00:00Z'))).toBe(false);
  });

  it('is not due before 08:00', () => {
    const occurrence = occurrenceFor('DAILY', at('2026-01-15T06:00:00Z'), OPTIONS);
    expect(isDue(occurrence, at('2026-01-15T06:00:00Z'))).toBe(false);
    expect(isDue(occurrence, at('2026-01-15T08:00:00Z'))).toBe(true);
  });
});

describe('weekly occurrences', () => {
  it('is identified by the Monday of the UK-local week', () => {
    // 2026-09-17 is a Thursday.
    const occurrence = occurrenceFor('WEEKLY', at('2026-09-17T12:00:00Z'), OPTIONS);

    expect(occurrence.occurrenceDate).toBe('2026-09-14');
    expect(occurrence.window).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const sunday = occurrenceFor('WEEKLY', at('2026-09-20T12:00:00Z'), OPTIONS);
    expect(sunday.occurrenceDate).toBe('2026-09-14');

    const nextMonday = occurrenceFor('WEEKLY', at('2026-09-21T12:00:00Z'), OPTIONS);
    expect(nextMonday.occurrenceDate).toBe('2026-09-21');
  });

  it('is catchable all week, but never into the next one', () => {
    const occurrence = occurrenceFor('WEEKLY', at('2026-09-14T09:00:00Z'), OPTIONS);

    // Still worth sending on Tuesday — the week it describes is current.
    expect(isWithinGrace(occurrence, at('2026-09-15T12:00:00Z'))).toBe(true);
    expect(isWithinGrace(occurrence, at('2026-09-20T22:00:00Z'))).toBe(true);
    // A Monday deploy must never post last week's summary.
    expect(isWithinGrace(occurrence, at('2026-09-20T23:30:00Z'))).toBe(false);
  });
});

describe('monthly occurrences', () => {
  it('is identified by the 1st of the UK-local month', () => {
    const occurrence = occurrenceFor('MONTHLY', at('2026-09-17T12:00:00Z'), OPTIONS);

    expect(occurrence.occurrenceDate).toBe('2026-09-01');
    expect(occurrence.window).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('covers the right last day for short and leap months', () => {
    expect(occurrenceFor('MONTHLY', at('2026-02-10T12:00:00Z'), OPTIONS).window.to).toBe(
      '2026-02-28',
    );
    expect(occurrenceFor('MONTHLY', at('2028-02-10T12:00:00Z'), OPTIONS).window.to).toBe(
      '2028-02-29',
    );
    expect(occurrenceFor('MONTHLY', at('2026-12-10T12:00:00Z'), OPTIONS).window.to).toBe(
      '2026-12-31',
    );
  });

  it('is catchable all month, but never into the next one', () => {
    const occurrence = occurrenceFor('MONTHLY', at('2026-09-01T09:00:00Z'), OPTIONS);

    expect(isWithinGrace(occurrence, at('2026-09-30T22:00:00Z'))).toBe(true);
    expect(isWithinGrace(occurrence, at('2026-09-30T23:30:00Z'))).toBe(false);
  });
});

describe('daylight saving transitions', () => {
  it('keeps 08:00 local across the spring-forward day', () => {
    // 2026-03-29: clocks go forward at 01:00. The day is 23 hours long.
    const before = occurrenceFor('DAILY', at('2026-03-28T12:00:00Z'), OPTIONS);
    const during = occurrenceFor('DAILY', at('2026-03-29T12:00:00Z'), OPTIONS);
    const after = occurrenceFor('DAILY', at('2026-03-30T12:00:00Z'), OPTIONS);

    expect(before.dueAt.toISOString()).toBe('2026-03-28T08:00:00.000Z');
    // Same 08:00 local, now one hour earlier in UTC.
    expect(during.dueAt.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(after.dueAt.toISOString()).toBe('2026-03-30T07:00:00.000Z');
  });

  it('keeps 08:00 local across the autumn-back day', () => {
    // 2026-10-25: clocks go back at 02:00, so by 08:00 the day is already on GMT and
    // 08:00 local is 08:00 UTC — the opposite of the spring case.
    const before = occurrenceFor('DAILY', at('2026-10-24T12:00:00Z'), OPTIONS);
    const during = occurrenceFor('DAILY', at('2026-10-25T12:00:00Z'), OPTIONS);
    const after = occurrenceFor('DAILY', at('2026-10-26T12:00:00Z'), OPTIONS);

    expect(before.dueAt.toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(during.dueAt.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(after.dueAt.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('gives the transition days their true 23- and 25-hour lengths', () => {
    // Measured between consecutive local midnights, which is what `graceEndsAt` is.
    // Nothing here assumes a fixed offset between local and UTC.
    const dayLength = (isoDuring: string, isoBefore: string): number => {
      const during = occurrenceFor('DAILY', at(isoDuring), OPTIONS);
      const previous = occurrenceFor('DAILY', at(isoBefore), OPTIONS);
      return (during.graceEndsAt.getTime() - previous.graceEndsAt.getTime()) / 3_600_000;
    };

    expect(dayLength('2026-03-29T12:00:00Z', '2026-03-28T12:00:00Z')).toBe(23);
    expect(dayLength('2026-10-25T12:00:00Z', '2026-10-24T12:00:00Z')).toBe(25);
  });

  it('covers a week spanning the autumn transition without losing an hour', () => {
    const occurrence = occurrenceFor('WEEKLY', at('2026-10-21T12:00:00Z'), OPTIONS);

    expect(occurrence.window).toEqual({ from: '2026-10-19', to: '2026-10-25' });

    // Measured between the week's own boundaries: 6 x 24h + 1 x 25h.
    const previousWeek = occurrenceFor('WEEKLY', at('2026-10-14T12:00:00Z'), OPTIONS);
    const hours =
      (occurrence.graceEndsAt.getTime() - previousWeek.graceEndsAt.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });

  it('covers a month spanning a transition', () => {
    const march = occurrenceFor('MONTHLY', at('2026-03-15T12:00:00Z'), OPTIONS);
    expect(march.window).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(march.dueAt.toISOString()).toBe('2026-03-01T08:00:00.000Z');
    expect(march.graceEndsAt.toISOString()).toBe('2026-03-31T23:00:00.000Z');
  });
});

describe('dueOccurrences', () => {
  const kinds = (now: string): string[] => dueOccurrences(at(now), OPTIONS).map((o) => o.kind);

  /**
   * A note on what "due" means here.
   *
   * The weekly and monthly occurrences stay due for their whole period — that IS the
   * catch-up mechanism. Whether they still need *running* is a question for the
   * database, not for this function, so a Tuesday tick legitimately offers Monday's
   * weekly and the runner finds it already done.
   */

  it('offers no daily before 08:00', () => {
    // 07:00 local on a Tuesday: the daily is not due yet.
    expect(kinds('2026-09-15T06:00:00Z')).not.toContain('DAILY');
  });

  it('offers the daily once 08:00 local has passed', () => {
    expect(kinds('2026-09-15T07:00:00Z')).toContain('DAILY');
  });

  it('offers daily and weekly on a Monday, sharing the same occurrence date', () => {
    const due = dueOccurrences(at('2026-09-14T07:00:00Z'), OPTIONS);
    const byKind = new Map(due.map((o) => [o.kind, o.occurrenceDate]));

    expect(byKind.get('DAILY')).toBe('2026-09-14');
    expect(byKind.get('WEEKLY')).toBe('2026-09-14');
  });

  it('offers daily and monthly on the 1st', () => {
    // Thursday 1 October 2026.
    const due = dueOccurrences(at('2026-10-01T07:00:00Z'), OPTIONS);
    const byKind = new Map(due.map((o) => [o.kind, o.occurrenceDate]));

    expect(byKind.get('DAILY')).toBe('2026-10-01');
    expect(byKind.get('MONTHLY')).toBe('2026-10-01');
  });

  it('offers all three on a Monday that is also the 1st', () => {
    // Monday 1 June 2026 — the case where suppressing one would be easy and wrong.
    const due = dueOccurrences(at('2026-06-01T07:00:00Z'), OPTIONS);

    expect(due.map((o) => o.kind)).toEqual(['DAILY', 'WEEKLY', 'MONTHLY']);
    expect(new Set(due.map((o) => o.occurrenceDate))).toEqual(new Set(['2026-06-01']));
  });

  it('keeps offering the week`s Monday later in the week, so a miss can be caught up', () => {
    const due = dueOccurrences(at('2026-09-16T12:00:00Z'), OPTIONS);
    expect(due.find((o) => o.kind === 'WEEKLY')?.occurrenceDate).toBe('2026-09-14');
  });

  it('never offers yesterday`s daily', () => {
    const due = dueOccurrences(at('2026-09-16T12:00:00Z'), OPTIONS);
    expect(due.find((o) => o.kind === 'DAILY')?.occurrenceDate).toBe('2026-09-16');
  });

  it('offers nothing at all at the very start of a period, before 08:00', () => {
    // Monday 1 June 2026 at 00:30 local: all three periods have just begun and none
    // has reached its 08:00 yet.
    expect(kinds('2026-05-31T23:30:00Z')).toEqual([]);
  });

  it('switches to the daily at 08:00 BST on the spring-forward morning', () => {
    // 08:00 BST is 07:00 UTC that day.
    expect(kinds('2026-03-29T06:59:00Z')).not.toContain('DAILY');
    expect(kinds('2026-03-29T07:00:00Z')).toContain('DAILY');
  });

  it('switches to the daily at 08:00 GMT on the autumn-back morning', () => {
    // 08:00 GMT is 08:00 UTC that day.
    expect(kinds('2026-10-25T07:59:00Z')).not.toContain('DAILY');
    expect(kinds('2026-10-25T08:00:00Z')).toContain('DAILY');
  });

  it('always returns narrowest first, so a busy morning reads in order', () => {
    const due = dueOccurrences(at('2026-06-01T07:00:00Z'), OPTIONS);
    expect(due.map((o) => o.kind)).toEqual(['DAILY', 'WEEKLY', 'MONTHLY']);
  });
});

describe('cron expressions', () => {
  it('fires at 08:00 for each kind', () => {
    expect(CRON_EXPRESSIONS).toEqual({
      DAILY: '0 8 * * *',
      WEEKLY: '0 8 * * 1',
      MONTHLY: '0 8 1 * *',
    });
  });
});
