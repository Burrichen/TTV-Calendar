/**
 * Calendar snapshots: the schedule, frozen, so a button click can be answered instantly.
 *
 * The split that makes this work: **GitHub Actions reads Tennis TV, Cloudflare reads
 * D1.** A modal has to open inside Slack's three-second interaction deadline, and a
 * Worker that had to fetch and parse an upstream schedule would not reliably manage it
 * — nor should the Worker know anything about Tennis TV (docs/ARCHITECTURE.md §15).
 *
 * So the morning job writes a snapshot, and the Worker renders it.
 *
 * What is stored is **normalised data, not rendered Slack JSON**. Rendering is
 * presentation and changes often; a snapshot of rendered blocks would freeze today's
 * design into stored state and need a migration every time the layout moved. Storing
 * the facts lets the Worker render whatever the current design is, including views that
 * did not exist when the snapshot was written.
 *
 * It is also deliberately not a copy of the Tennis TV database — only the fields a
 * calendar view actually shows.
 */

import type { Match, Tournament } from './types.ts';

export const SNAPSHOT_PERIODS = ['WEEK', 'MONTH'] as const;
export type SnapshotPeriod = (typeof SNAPSHOT_PERIODS)[number];

/**
 * Whether a snapshot is the real schedule or a drill.
 *
 * Part of the primary key, so a simulation writes alongside production rather than over
 * it — the guarantee that a test can never blank a real calendar.
 */
export const SNAPSHOT_VARIANTS = ['LIVE', 'TEST'] as const;
export type SnapshotVariant = (typeof SNAPSHOT_VARIANTS)[number];

/** One match, reduced to what a calendar view displays. */
export interface SnapshotMatch {
  /** Stable composite identity, so a view can be correlated with an alert. */
  readonly matchKey: string;
  readonly tournamentName: string;
  readonly sideOne: string;
  readonly sideTwo: string;
  /** ISO-8601 UTC, or null when Tennis TV has published no start time. */
  readonly startsAtUtc: string | null;
  /** The local calendar date this match is listed under, `YYYY-MM-DD`. */
  readonly onDate: string;
}

/** One tournament, reduced to what the month overview displays. */
export interface SnapshotTournament {
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly sourceUrl: string | null;
  /** How many of this snapshot's matches belong to it. */
  readonly matchCount: number;
}

export interface CalendarSnapshot {
  readonly periodType: SnapshotPeriod;
  /** `week:2026-W40` or `month:2026-09`. */
  readonly periodKey: string;
  /** Inclusive local date range the snapshot covers. */
  readonly from: string;
  readonly to: string;
  /** The IANA zone every date and time in here was resolved against. */
  readonly timezone: string;
  /** When the schedule was read from Tennis TV. ISO-8601 UTC. */
  readonly generatedAt: string;
  readonly tournaments: readonly SnapshotTournament[];
  readonly matches: readonly SnapshotMatch[];
}

/**
 * How many matches a snapshot may hold.
 *
 * A month of full draws is a few hundred; this is a ceiling that keeps one row well
 * inside D1's limits however unusual a month turns out to be. Exceeding it truncates
 * with the count preserved rather than failing the write — a partial calendar is worth
 * more than none, and the public summaries still state the true totals.
 */
export const MAX_SNAPSHOT_MATCHES = 1500;

/** `week:2026-W40`. The ISO week-numbering year, so a New Year week has one key. */
export const weekSnapshotKey = (weekYear: number, weekNumber: number): string =>
  `week:${String(weekYear)}-W${String(weekNumber).padStart(2, '0')}`;

/** `month:2026-09`. */
export const monthSnapshotKey = (year: number, month: number): string =>
  `month:${String(year)}-${String(month).padStart(2, '0')}`;

export const isSnapshotPeriod = (value: string): value is SnapshotPeriod =>
  (SNAPSHOT_PERIODS as readonly string[]).includes(value);

export const isSnapshotVariant = (value: string): value is SnapshotVariant =>
  (SNAPSHOT_VARIANTS as readonly string[]).includes(value);

export interface SnapshotSource {
  readonly periodType: SnapshotPeriod;
  readonly periodKey: string;
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly generatedAt: Date;
  readonly tournaments: readonly Tournament[];
  readonly matches: readonly Match[];
  /** The local date each match should be filed under, already resolved by the caller. */
  readonly localDateOf: (match: Match) => string;
}

/** Reduces domain objects to the snapshot's deliberately small shape. */
export function buildSnapshot(source: SnapshotSource): CalendarSnapshot {
  const matches = source.matches.slice(0, MAX_SNAPSHOT_MATCHES).map((match) => ({
    matchKey: `${match.id.tournament.providerTournamentId}:${String(match.id.tournament.year)}:${match.id.providerMatchId}`,
    tournamentName: match.tournamentName,
    sideOne: match.sideOne.name,
    sideTwo: match.sideTwo.name,
    startsAtUtc: match.schedule.startsAtUtc?.toISOString() ?? null,
    onDate: source.localDateOf(match),
  }));

  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.tournamentName, (counts.get(match.tournamentName) ?? 0) + 1);
  }

  const tournaments = [...source.tournaments]
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name))
    .map((tournament) => ({
      name: tournament.name,
      startsOn: tournament.startsOn,
      endsOn: tournament.endsOn,
      sourceUrl: tournament.sourceUrl,
      matchCount: counts.get(tournament.name) ?? 0,
    }));

  return {
    periodType: source.periodType,
    periodKey: source.periodKey,
    from: source.from,
    to: source.to,
    timezone: source.timezone,
    generatedAt: source.generatedAt.toISOString(),
    tournaments,
    matches,
  };
}
