/**
 * Which slice of the calendar a run asks Tennis TV about.
 *
 * Windows are expressed in local calendar dates because that is what the provider's
 * date filters take, and what the reports are scoped by (PROJECT_SPEC.md §7).
 *
 * The monitor asks only for today — 81 tournaments and their draws is a lot of
 * bandwidth to answer "what is on right now".
 */

import { DateTime } from 'luxon';

import type { DateRange } from '../tennistv/provider.ts';

export interface WindowOptions {
  /** Days of history to retain. Enough to keep yesterday's context for diagnostics. */
  readonly lookBehindDays?: number;
  /** Days ahead. Must comfortably exceed the end of the current month. */
  readonly lookAheadDays?: number;
}

const DEFAULT_LOOK_BEHIND_DAYS = 7;
const DEFAULT_LOOK_AHEAD_DAYS = 45;

/**
 * A wide window: a little history, and far enough ahead to cover the whole month.
 *
 * Production no longer syncs a standing window — each run reads exactly the range it
 * needs. This remains the window the upstream contract test sweeps, because exercising
 * the real API across a month is how a change in Tennis TV's shape gets noticed.
 */
export function syncWindow(now: Date, zone: string, options: WindowOptions = {}): DateRange {
  const lookBehind = options.lookBehindDays ?? DEFAULT_LOOK_BEHIND_DAYS;
  const lookAhead = options.lookAheadDays ?? DEFAULT_LOOK_AHEAD_DAYS;

  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const monthEnd = today.endOf('month');
  // Never return a window that stops before the current month does.
  const ahead = today.plus({ days: lookAhead });
  const to = ahead > monthEnd ? ahead : monthEnd;

  return { from: isoDate(today.minus({ days: lookBehind })), to: isoDate(to) };
}

/** The local calendar day containing `now`, as a single-day range. */
export function todayRange(now: Date, zone: string): DateRange {
  const today = isoDate(DateTime.fromJSDate(now, { zone }).startOf('day'));
  return { from: today, to: today };
}

const isoDate = (value: DateTime): string => value.toISODate() ?? '';
