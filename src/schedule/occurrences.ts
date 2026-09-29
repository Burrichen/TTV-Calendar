/**
 * What is due, and until when.
 *
 * The whole scheduling design rests on one idea: **cron is a trigger, not the source
 * of truth**. Every firing — and every boot, and every sweep — resolves to the same
 * *occurrence*, identified by its kind and its local calendar date. Whether that
 * occurrence still needs doing is a question for the database, not for whether a timer
 * happened to be alive at 08:00 (ARCHITECTURE.md §7).
 *
 * This module is pure: no I/O, no `Date.now()`, no timers. Every function takes the
 * current instant explicitly, which is what makes the DST and catch-up behaviour
 * testable by simply choosing an instant.
 *
 * All reasoning is done with Luxon over an IANA zone. No offset is ever computed,
 * compared or written down (PROJECT_SPEC.md §7).
 */

import { DateTime } from 'luxon';

import type { SummaryKind } from '../domain/types.ts';

export const SUMMARY_KINDS = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

/** The hour, in `APP_TIMEZONE`, at which all three reports are due. */
export const SUMMARY_HOUR = 8;

export interface Occurrence {
  readonly kind: SummaryKind;
  /**
   * The occurrence's identity: the local calendar date it belongs to.
   *
   * Daily — the day itself. Weekly — that week's Monday. Monthly — the 1st.
   */
  readonly occurrenceDate: string;
  /** The instant it became due: 08:00 local on `occurrenceDate`. */
  readonly dueAt: Date;
  /**
   * The instant after which it is too late to catch up.
   *
   * End of the period it describes. A weekly summary is still worth sending on
   * Tuesday — the week is current — but never the following week.
   */
  readonly graceEndsAt: Date;
  /** Inclusive local date range the report covers. */
  readonly window: { readonly from: string; readonly to: string };
}

export interface OccurrenceOptions {
  readonly timezone: string;
  /** Overridable so tests can avoid arranging data around 08:00. */
  readonly hour?: number;
}

/**
 * The occurrence of `kind` that the given instant falls within.
 *
 * Always returns one — "which daily report does this moment belong to" always has an
 * answer. Whether it is *due* yet is `isDue`.
 */
export function occurrenceFor(
  kind: SummaryKind,
  now: Date,
  options: OccurrenceOptions,
): Occurrence {
  const zone = options.timezone;
  const hour = options.hour ?? SUMMARY_HOUR;
  const local = DateTime.fromJSDate(now, { zone });

  switch (kind) {
    case 'DAILY': {
      const start = local.startOf('day');
      return build(kind, start, start.plus({ days: 1 }), hour);
    }
    case 'WEEKLY': {
      // Luxon's week starts on Monday, which is the UK convention and the one
      // PROJECT_SPEC.md §4.2 specifies.
      const start = local.startOf('week');
      return build(kind, start, start.plus({ weeks: 1 }), hour);
    }
    case 'MONTHLY': {
      const start = local.startOf('month');
      return build(kind, start, start.plus({ months: 1 }), hour);
    }
  }
}

/**
 * Builds an occurrence from the local period it covers.
 *
 * `exclusiveEnd` is the start of the next period, so the covered range and the grace
 * window both fall out of the zone's own arithmetic — including the 23- and 25-hour
 * days either side of a DST change.
 */
function build(
  kind: SummaryKind,
  start: DateTime,
  exclusiveEnd: DateTime,
  hour: number,
): Occurrence {
  const dueAt = start.set({ hour, minute: 0, second: 0, millisecond: 0 });

  return {
    kind,
    occurrenceDate: isoDate(start),
    dueAt: dueAt.toUTC().toJSDate(),
    graceEndsAt: exclusiveEnd.toUTC().toJSDate(),
    window: { from: isoDate(start), to: isoDate(exclusiveEnd.minus({ days: 1 })) },
  };
}

/** Whether the occurrence's 08:00 has arrived. */
export const isDue = (occurrence: Occurrence, now: Date): boolean =>
  now.getTime() >= occurrence.dueAt.getTime();

/** Whether it is still worth running late. */
export const isWithinGrace = (occurrence: Occurrence, now: Date): boolean =>
  now.getTime() < occurrence.graceEndsAt.getTime();

/**
 * Every occurrence that should have run by `now` and is still catchable.
 *
 * This is the entire catch-up mechanism. A boot at 08:05 finds the day's daily due and
 * not yet complete; a boot on Monday at 09:00 finds the daily *and* the weekly, and on
 * the 1st of a month that is also a Monday it finds all three. Nothing is suppressed
 * because something else is due the same morning — the three reports are independent
 * requirements (PROJECT_SPEC.md §4).
 *
 * Returned in a deliberate order: daily, then weekly, then monthly, so a busy morning
 * reads narrowest-first in the channel.
 */
export function dueOccurrences(now: Date, options: OccurrenceOptions): Occurrence[] {
  return SUMMARY_KINDS.map((kind) => occurrenceFor(kind, now, options)).filter(
    (occurrence) => isDue(occurrence, now) && isWithinGrace(occurrence, now),
  );
}

/**
 * Cron expressions for the punctual triggers.
 *
 * These make the reports arrive *on time*; the sweep and the boot catch-up make them
 * arrive *at all*. Both routes go through the same idempotent runner, so having both
 * costs nothing and losing either is survivable.
 */
export const CRON_EXPRESSIONS: Readonly<Record<SummaryKind, string>> = {
  DAILY: `0 ${String(SUMMARY_HOUR)} * * *`,
  WEEKLY: `0 ${String(SUMMARY_HOUR)} * * 1`,
  MONTHLY: `0 ${String(SUMMARY_HOUR)} 1 * *`,
};

const isoDate = (value: DateTime): string => value.toISODate() ?? '';
