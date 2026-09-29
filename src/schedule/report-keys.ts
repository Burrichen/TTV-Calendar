/**
 * Stable identities for the three scheduled reports.
 *
 * These strings are the primary keys that make a report unrepeatable, so they must be
 * derived from the calendar and never from "when the run happened to start". A run at
 * 08:00 and a catch-up run at 08:40 produce the same key for the same morning, which is
 * the entire duplicate-prevention mechanism.
 *
 * Computed by the Node application, which owns the reports, and presented to the state
 * API as an opaque key (docs/ARCHITECTURE.md §16).
 *
 * The weekly key uses the ISO-8601 week date (`2026-W38`), which is the standards-based
 * representation: its year is the ISO week-numbering year, so the week spanning New
 * Year gets one key rather than two.
 */

import { DateTime } from 'luxon';

import type { SummaryKind } from '../domain/types.ts';
import type { Occurrence } from './occurrences.ts';

export function reportKey(occurrence: Occurrence, zone: string): string {
  // The occurrence date is already the period's first local day: the day itself, that
  // week's Monday, or the 1st of the month.
  const date = DateTime.fromISO(occurrence.occurrenceDate, { zone });

  switch (occurrence.kind) {
    case 'DAILY':
      return `daily:${occurrence.occurrenceDate}`;
    case 'WEEKLY':
      return `weekly:${String(date.weekYear)}-W${String(date.weekNumber).padStart(2, '0')}`;
    case 'MONTHLY':
      return `monthly:${date.toFormat('yyyy-MM')}`;
  }
}

/** Human-readable label for logs. */
export const reportLabel = (kind: SummaryKind): string => kind.toLowerCase();
