/**
 * Time windows and display, in one place.
 *
 * Rules from PROJECT_SPEC.md §7, all enforced here rather than at call sites:
 *  - canonical values are absolute instants (UTC)
 *  - every user-facing time is rendered in the configured IANA zone
 *  - GMT/BST resolves from the zone database; no offset is ever written down
 */

import { DateTime, FixedOffsetZone } from 'luxon';

import type { MatchSchedule } from './types.ts';

/** A half-open interval `[startUtc, endUtc)` covering a local calendar span. */
export interface TimeWindow {
  readonly startUtc: Date;
  readonly endUtc: Date;
  /** First local calendar date in the window, `YYYY-MM-DD`. */
  readonly firstDate: string;
  /** Last local calendar date in the window, `YYYY-MM-DD`. */
  readonly lastDate: string;
}

const localDay = (reference: Date, zone: string): DateTime =>
  DateTime.fromJSDate(reference, { zone }).startOf('day');

function toWindow(start: DateTime, end: DateTime): TimeWindow {
  return {
    startUtc: start.toUTC().toJSDate(),
    endUtc: end.toUTC().toJSDate(),
    firstDate: start.toISODate() ?? '',
    lastDate: end.minus({ days: 1 }).toISODate() ?? '',
  };
}

/** The local calendar day containing `reference`. */
export function dayWindow(reference: Date, zone: string): TimeWindow {
  const start = localDay(reference, zone);
  return toWindow(start, start.plus({ days: 1 }));
}

/** Monday 00:00 to the following Monday 00:00, local. */
export function weekWindow(reference: Date, zone: string): TimeWindow {
  const start = localDay(reference, zone).startOf('week');
  return toWindow(start, start.plus({ weeks: 1 }));
}

/** The 1st 00:00 to the 1st of the next month 00:00, local. */
export function monthWindow(reference: Date, zone: string): TimeWindow {
  const start = localDay(reference, zone).startOf('month');
  return toWindow(start, start.plus({ months: 1 }));
}

/** The local calendar date of an instant, `YYYY-MM-DD`. */
export function localDateOf(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate() ?? '';
}

/**
 * Combines a venue-local wall clock with a venue offset supplied by the source.
 *
 * The offset is data, not a constant — passing it in is what keeps
 * PROJECT_SPEC.md §7's "never hard-code an offset" rule honest. Returns null when the
 * offset is unknown or the wall clock does not parse, because a start time we cannot
 * place on the timeline is not a start time.
 */
export function venueWallClockToUtc(
  isoLocal: string,
  venueOffsetMinutes: number | null,
): Date | null {
  if (venueOffsetMinutes === null) return null;

  const parsed = DateTime.fromISO(isoLocal, { zone: FixedOffsetZone.instance(venueOffsetMinutes) });
  return parsed.isValid ? parsed.toUTC().toJSDate() : null;
}

/** How a start time is shown to users: a local time, or the literal `Time TBC`. */
export const TIME_TBC = 'Time TBC';

export function formatStartTime(schedule: MatchSchedule, zone: string): string {
  if (schedule.startsAtUtc === null) return TIME_TBC;
  return DateTime.fromJSDate(schedule.startsAtUtc, { zone }).toFormat('HH:mm');
}

/** A date as users read it, e.g. `Mon 14 Sep`. */
export function formatDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('ccc d LLL');
}

/** A `YYYY-MM-DD` calendar date as users read it, without inventing a time. */
export function formatCalendarDate(isoDate: string, zone: string): string {
  return DateTime.fromISO(isoDate, { zone }).toFormat('ccc d LLL');
}
