/**
 * Refreshing the calendar snapshots the Slack modals read.
 *
 * Run as part of the morning job, because that is when the schedule is already in
 * memory: the reports have just been rendered from it, so writing a snapshot costs two
 * state API calls and no extra Tennis TV request.
 *
 * The Worker can then answer a "View week" click from D1 alone, inside Slack's
 * interaction deadline, without knowing Tennis TV exists.
 */

import { DateTime } from 'luxon';

import {
  buildSnapshot,
  monthSnapshotKey,
  weekSnapshotKey,
  type SnapshotVariant,
} from '../domain/snapshot.ts';
import type { Match, Tournament } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import type { StateApi } from '../state/client.ts';
import { localDate, matchesWithin, tournamentsWithin } from './schedule-reader.ts';

export interface SnapshotRefreshOptions {
  readonly state: StateApi;
  readonly logger: Logger;
  readonly timezone: string;
  readonly now: Date;
  readonly tournaments: readonly Tournament[];
  readonly matches: readonly Match[];
  /** `TEST` writes alongside the real snapshots rather than over them. */
  readonly variant: SnapshotVariant;
}

export interface SnapshotRefreshResult {
  readonly written: readonly string[];
  readonly failed: number;
}

/**
 * Writes the current week and the current month.
 *
 * Only those two: they are what the buttons open. Writing next month as well would
 * double the work for a view nobody can reach yet, and the schedule that far ahead is
 * mostly unpublished anyway (docs/TENNISTV_DATA_SOURCE.md §7).
 *
 * A failure here never fails the morning run. The reports are the job; the snapshots
 * are a convenience, and a stale one degrades to a view that says when it was taken.
 */
export async function refreshSnapshots(
  options: SnapshotRefreshOptions,
): Promise<SnapshotRefreshResult> {
  const local = DateTime.fromJSDate(options.now, { zone: options.timezone });

  const periods = [
    {
      periodType: 'WEEK' as const,
      periodKey: weekSnapshotKey(local.weekYear, local.weekNumber),
      from: isoDate(local.startOf('week')),
      to: isoDate(local.endOf('week')),
    },
    {
      periodType: 'MONTH' as const,
      periodKey: monthSnapshotKey(local.year, local.month),
      from: isoDate(local.startOf('month')),
      to: isoDate(local.endOf('month')),
    },
  ];

  const written: string[] = [];
  let failed = 0;

  for (const period of periods) {
    try {
      const snapshot = buildSnapshot({
        ...period,
        timezone: options.timezone,
        generatedAt: options.now,
        tournaments: tournamentsWithin(options.tournaments, period.from, period.to),
        matches: matchesWithin(options.matches, period.from, period.to, options.timezone),
        localDateOf: (match) => localDate(match, options.timezone),
      });

      await options.state.saveSnapshot(snapshot, options.variant);
      written.push(period.periodKey);

      options.logger.info(
        {
          periodKey: period.periodKey,
          variant: options.variant,
          matches: snapshot.matches.length,
          tournaments: snapshot.tournaments.length,
        },
        'calendar snapshot refreshed',
      );
    } catch (error) {
      failed += 1;
      options.logger.warn(
        { err: error, periodKey: period.periodKey },
        'could not refresh a calendar snapshot; the modal will show the previous one',
      );
    }
  }

  return { written, failed };
}

const isoDate = (value: DateTime): string => value.toISODate() ?? '';
