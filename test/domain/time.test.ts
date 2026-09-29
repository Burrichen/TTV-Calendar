import { describe, expect, it } from 'vitest';

import {
  TIME_TBC,
  dayWindow,
  formatCalendarDate,
  formatStartTime,
  localDateOf,
  monthWindow,
  venueWallClockToUtc,
  weekWindow,
} from '../../src/domain/time.ts';
import type { MatchSchedule } from '../../src/domain/types.ts';

const ZONE = 'Europe/London';

const schedule = (overrides: Partial<MatchSchedule> = {}): MatchSchedule => ({
  onDate: '2026-09-14',
  startsAtUtc: null,
  notBeforeUtc: null,
  tbcReason: null,
  ...overrides,
});

describe('day windows', () => {
  it('covers a GMT day as 00:00 to 00:00 UTC', () => {
    const window = dayWindow(new Date('2026-01-15T12:00:00Z'), ZONE);
    expect(window.startUtc.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(window.endUtc.toISOString()).toBe('2026-01-16T00:00:00.000Z');
    expect(window.firstDate).toBe('2026-01-15');
    expect(window.lastDate).toBe('2026-01-15');
  });

  it('covers a BST day as 23:00 to 23:00 UTC', () => {
    // The window shifts because the zone does, not because we applied an offset.
    const window = dayWindow(new Date('2026-08-15T12:00:00Z'), ZONE);
    expect(window.startUtc.toISOString()).toBe('2026-08-14T23:00:00.000Z');
    expect(window.endUtc.toISOString()).toBe('2026-08-15T23:00:00.000Z');
    expect(window.firstDate).toBe('2026-08-15');
  });

  it('uses local midnight, not UTC midnight, to decide the day', () => {
    // 23:30 UTC in August is already the next day in London.
    expect(localDateOf(new Date('2026-08-14T23:30:00Z'), ZONE)).toBe('2026-08-15');
  });

  describe('across DST transitions', () => {
    it('handles the 23-hour spring-forward day', () => {
      const window = dayWindow(new Date('2026-03-29T12:00:00Z'), ZONE);
      const hours = (window.endUtc.getTime() - window.startUtc.getTime()) / 3_600_000;
      expect(hours).toBe(23);
    });

    it('handles the 25-hour autumn-back day', () => {
      const window = dayWindow(new Date('2026-10-25T12:00:00Z'), ZONE);
      const hours = (window.endUtc.getTime() - window.startUtc.getTime()) / 3_600_000;
      expect(hours).toBe(25);
    });
  });
});

describe('week windows', () => {
  it('starts on Monday local time', () => {
    // 2026-09-14 is a Monday; a reference mid-week must resolve to the same window.
    const fromMonday = weekWindow(new Date('2026-09-14T09:00:00Z'), ZONE);
    const fromThursday = weekWindow(new Date('2026-09-17T09:00:00Z'), ZONE);

    expect(fromMonday.firstDate).toBe('2026-09-14');
    expect(fromMonday.lastDate).toBe('2026-09-20');
    expect(fromThursday).toEqual(fromMonday);
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const window = weekWindow(new Date('2026-09-20T09:00:00Z'), ZONE);
    expect(window.firstDate).toBe('2026-09-14');
  });

  it('spans the October DST change correctly', () => {
    const window = weekWindow(new Date('2026-10-21T09:00:00Z'), ZONE);
    expect(window.firstDate).toBe('2026-10-19');
    expect(window.lastDate).toBe('2026-10-25');
    // Six 24-hour days plus one 25-hour day.
    const hours = (window.endUtc.getTime() - window.startUtc.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });
});

describe('month windows', () => {
  it('runs from the 1st to the last day inclusive', () => {
    const window = monthWindow(new Date('2026-09-14T09:00:00Z'), ZONE);
    expect(window.firstDate).toBe('2026-09-01');
    expect(window.lastDate).toBe('2026-09-30');
  });

  it('handles a February in a non-leap year', () => {
    expect(monthWindow(new Date('2026-02-10T09:00:00Z'), ZONE).lastDate).toBe('2026-02-28');
  });

  it('handles December rolling into January', () => {
    const window = monthWindow(new Date('2026-12-20T09:00:00Z'), ZONE);
    expect(window.lastDate).toBe('2026-12-31');
    expect(window.endUtc.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('venueWallClockToUtc', () => {
  it('applies an offset supplied by the source', () => {
    // US Open 2026 reports utcOffset -4; the offset is data, never a constant.
    expect(venueWallClockToUtc('2026-08-24T11:00:00', -4 * 60)?.toISOString()).toBe(
      '2026-08-24T15:00:00.000Z',
    );
  });

  it('handles a half-hour offset', () => {
    expect(venueWallClockToUtc('2026-01-05T14:30:00', 5 * 60 + 30)?.toISOString()).toBe(
      '2026-01-05T09:00:00.000Z',
    );
  });

  it('returns null when the offset is unknown', () => {
    // One tournament in 81 had no utcOffset. A time we cannot place is not a time.
    expect(venueWallClockToUtc('2026-08-24T11:00:00', null)).toBeNull();
  });

  it('returns null for an unparseable wall clock rather than inventing one', () => {
    expect(venueWallClockToUtc('not-a-date', 0)).toBeNull();
  });
});

describe('formatStartTime', () => {
  it('renders GMT in winter', () => {
    expect(formatStartTime(schedule({ startsAtUtc: new Date('2026-01-15T19:04:00Z') }), ZONE)).toBe(
      '19:04',
    );
  });

  it('renders BST in summer', () => {
    expect(formatStartTime(schedule({ startsAtUtc: new Date('2026-08-15T18:04:00Z') }), ZONE)).toBe(
      '19:04',
    );
  });

  it('renders Time TBC when no start time is published', () => {
    expect(formatStartTime(schedule(), ZONE)).toBe(TIME_TBC);
    expect(TIME_TBC).toBe('Time TBC');
  });

  it('renders Time TBC even when a not-before time exists', () => {
    // A "not before" time is not a start time and must never be promoted to one.
    const tbc = schedule({
      notBeforeUtc: new Date('2026-09-14T09:00:00Z'),
      tbcReason: 'NOT_BEFORE_ONLY',
    });
    expect(formatStartTime(tbc, ZONE)).toBe(TIME_TBC);
  });
});

describe('formatCalendarDate', () => {
  it('renders a calendar date without inventing a time', () => {
    expect(formatCalendarDate('2026-09-14', ZONE)).toBe('Mon 14 Sep');
  });

  it('renders a date on the far side of a DST change', () => {
    expect(formatCalendarDate('2026-10-26', ZONE)).toBe('Mon 26 Oct');
  });
});
