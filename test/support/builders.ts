/**
 * Builders for domain objects.
 *
 * Every field has a sensible default, so a test states only what it is actually about —
 * a match's status, or its start time — and the reader is not made to scan past a dozen
 * irrelevant properties to find the point.
 */

import type { Match, MatchStatus, Tournament } from '../../src/domain/types.ts';

export interface TournamentOverrides {
  readonly id?: string;
  readonly year?: number;
  readonly name?: string;
  readonly startsOn?: string;
  readonly endsOn?: string;
  readonly hasPublishedMatches?: boolean;
  readonly isShownOnTennisTv?: boolean;
}

export function aTournament(overrides: TournamentOverrides = {}): Tournament {
  const startsOn = overrides.startsOn ?? '2026-09-29';

  return {
    id: {
      providerTournamentId: overrides.id ?? '4713',
      year: overrides.year ?? 2026,
    },
    name: overrides.name ?? 'Example Open',
    location: 'Testland',
    city: 'Testville',
    startsOn,
    endsOn: overrides.endsOn ?? startsOn,
    venueUtcOffsetMinutes: 0,
    isShownOnTennisTv: overrides.isShownOnTennisTv ?? true,
    notShownReason: null,
    sourceUrl: null,
    hasPublishedMatches: overrides.hasPublishedMatches ?? true,
    isSimulated: false,
  };
}

export interface MatchOverrides {
  readonly tournamentId?: string;
  readonly year?: number;
  readonly matchId?: string;
  readonly tournamentName?: string;
  readonly sideOne?: string;
  readonly sideTwo?: string;
  readonly status?: MatchStatus;
  readonly onDate?: string;
  readonly startsAtUtc?: Date | null;
  readonly isShownOnTennisTv?: boolean;
  readonly round?: string | null;
  readonly court?: string | null;
}

export function aMatch(overrides: MatchOverrides = {}): Match {
  const startsAtUtc =
    overrides.startsAtUtc === undefined ? new Date('2026-09-29T13:00:00Z') : overrides.startsAtUtc;

  return {
    id: {
      tournament: {
        providerTournamentId: overrides.tournamentId ?? '4713',
        year: overrides.year ?? 2026,
      },
      providerMatchId: overrides.matchId ?? 'MS011',
    },
    tournamentName: overrides.tournamentName ?? 'Example Open',
    sideOne: { name: overrides.sideOne ?? 'Player A', isKnown: true },
    sideTwo: { name: overrides.sideTwo ?? 'Player B', isKnown: true },
    schedule: {
      onDate: overrides.onDate ?? '2026-09-29',
      startsAtUtc,
      notBeforeUtc: null,
      tbcReason: startsAtUtc === null ? 'NOT_PUBLISHED' : null,
    },
    status: overrides.status ?? 'SCHEDULED',
    rawStatus: { primary: 'U', secondary: null, reason: null, unmapped: false },
    round: overrides.round === undefined ? 'Round of 16' : overrides.round,
    court: overrides.court === undefined ? 'Centre Court' : overrides.court,
    isShownOnTennisTv: overrides.isShownOnTennisTv ?? true,
    isSimulated: false,
  };
}
