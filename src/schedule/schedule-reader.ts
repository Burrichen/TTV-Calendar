/**
 * Reading the schedule from Tennis TV.
 *
 * The original design kept a synchronised copy of the schedule in PostgreSQL and
 * rendered reports from it. There is no such copy any more: a report is rendered from a
 * fresh read, which is simpler, always current, and removes a whole class of "the copy
 * disagrees with the source" bugs.
 *
 * The cost is request volume, so the shape here is deliberate: **one** tournament read
 * per run, and match reads only for tournaments that are actually relevant. The
 * provider's own read-through cache then makes a second look at the same tournament
 * free within a run, which is what lets the daily, weekly and monthly reports share one
 * fetch on a Monday the 1st.
 */

import { DateTime } from 'luxon';

import { availableMatches, availableTournaments } from '../domain/availability.ts';
import type { Match, Tournament } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import type { DateRange, TennisTvProvider } from '../tennistv/provider.ts';

/**
 * Tournaments overlapping `range`, excluding those Tennis TV says it does not show.
 *
 * Availability is filtered here rather than in the reports, so nothing downstream can
 * accidentally advertise a tournament that is not on the platform (PROJECT_SPEC.md §9).
 */
export async function fetchTournaments(
  provider: TennisTvProvider,
  range: DateRange,
  logger: Logger,
): Promise<{ tournaments: readonly Tournament[]; skipped: number }> {
  const snapshot = await provider.getTournaments(range);
  const tournaments = availableTournaments(snapshot.tournaments);

  logger.debug(
    {
      range: `${range.from}..${range.to}`,
      returned: snapshot.tournaments.length,
      available: tournaments.length,
      skipped: snapshot.skipped,
      fromCache: snapshot.fromCache,
    },
    'tournaments read',
  );

  return { tournaments, skipped: snapshot.skipped };
}

/**
 * Matches for the given tournaments.
 *
 * Tournaments whose draw is not out yet are skipped without a request:
 * `hasPublishedMatches` is the provider's own signal that match records do not exist,
 * and asking anyway would be a guaranteed-empty round trip
 * (docs/TENNISTV_DATA_SOURCE.md §7).
 *
 * One tournament failing does not fail the rest. A report covering four of five
 * tournaments is worth sending; the omission is logged and counted.
 */
export async function fetchMatches(
  provider: TennisTvProvider,
  tournaments: readonly Tournament[],
  logger: Logger,
): Promise<{ matches: readonly Match[]; skipped: number; failed: number }> {
  const matches: Match[] = [];
  let skipped = 0;
  let failed = 0;

  for (const tournament of tournaments) {
    if (!tournament.hasPublishedMatches) continue;

    try {
      const snapshot = await provider.getTournamentMatches(tournament.id);
      matches.push(...availableMatches(snapshot.matches));
      skipped += snapshot.skipped;
    } catch (error) {
      failed += 1;
      logger.warn(
        { err: error, tournament: tournament.name },
        'could not read matches for a tournament; continuing with the rest',
      );
    }
  }

  return { matches, skipped, failed };
}

/** Tournaments whose run overlaps the inclusive local-date range. */
export const tournamentsWithin = (
  tournaments: readonly Tournament[],
  from: string,
  to: string,
): Tournament[] =>
  tournaments.filter((tournament) => tournament.startsOn <= to && tournament.endsOn >= from);

/**
 * Matches falling inside the inclusive local-date range.
 *
 * Filtered on the *venue's* calendar date where the start time is unknown, and on the
 * UK calendar date where it is known — because that is the date the reader will see in
 * the report, and a report must not list a match under a day it does not show.
 */
export function matchesWithin(
  matches: readonly Match[],
  from: string,
  to: string,
  zone: string,
): Match[] {
  return matches.filter((match) => {
    const date = localDate(match, zone);
    return date >= from && date <= to;
  });
}

/** The calendar date a match will be listed under. */
export function localDate(match: Match, zone: string): string {
  const startsAt = match.schedule.startsAtUtc;
  if (startsAt === null) return match.schedule.onDate;
  return DateTime.fromJSDate(startsAt, { zone }).toISODate() ?? match.schedule.onDate;
}

/** The smallest range containing `base` and every extra window. */
export function widen(base: DateRange, extras: readonly DateRange[]): DateRange {
  let { from, to } = base;

  for (const range of extras) {
    if (range.from < from) from = range.from;
    if (range.to > to) to = range.to;
  }

  return { from, to };
}
