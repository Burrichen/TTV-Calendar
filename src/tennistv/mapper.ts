/**
 * Raw Tennis TV payloads to domain objects.
 *
 * This is where every judgement about the source's quirks is made, and the last place
 * a Tennis TV field name appears. The rules come from measurement, not guesswork —
 * docs/TENNISTV_DATA_SOURCE.md §6 and §8 are the evidence for each one.
 *
 * The overriding principle: **never invent**. Where the source is silent or ambiguous,
 * the result is a null with a recorded reason, not a plausible value.
 */

import { DateTime, FixedOffsetZone } from 'luxon';

import type { Competitor, MatchSchedule, TbcReason, TournamentId } from '../domain/types.ts';
import type { ProviderMatch, ProviderTournament } from './provider.ts';
import type { RawMatch, RawTournament } from './schemas.ts';
import { mapStatus } from './status-map.ts';

export interface MapperOptions {
  /** Public site base, used to build source URLs. */
  readonly siteBaseUrl: string;
}

// ---------------------------------------------------------------- tournaments

export function mapTournament(raw: RawTournament, options: MapperOptions): ProviderTournament {
  const metadata = raw.metadata;
  const info = raw.info;

  // Absence of the marker means shown. Only an explicit `true` excludes a tournament
  // (PROJECT_SPEC.md §9) — 20 of 81 tournaments carry no metadata at all.
  const notShownReason =
    metadata?.notShown === true ? (metadata.broadcastText ?? 'Not shown on Tennis TV') : null;

  return {
    id: { providerTournamentId: String(raw.id), year: raw.year },
    name: raw.name,
    location: raw.location ?? null,
    city: info?.city ?? null,
    startsOn: raw.start,
    endsOn: raw.end,
    venueUtcOffsetMinutes: toOffsetMinutes(info?.utcOffset),
    isShownOnTennisTv: notShownReason === null,
    notShownReason,
    sourceUrl: toSourceUrl(metadata?.customRoute, options.siteBaseUrl),
    // The presence of an order of play is the only reliable signal that match records
    // exist; `matchesSize` is a forecast and must never be read as a count.
    hasPublishedMatches: (raw.availableOopDays ?? []).length > 0,
    // Anything the provider gives us is real by definition.
    isSimulated: false,
    raw,
  };
}

/** Decimal hours from the payload (`-4`, `8`, `5.5`) to whole minutes east of UTC. */
function toOffsetMinutes(utcOffset: number | null | undefined): number | null {
  if (typeof utcOffset !== 'number' || !Number.isFinite(utcOffset)) return null;
  return Math.round(utcOffset * 60);
}

function toSourceUrl(route: string | undefined, siteBaseUrl: string): string | null {
  if (route === undefined || route === '') return null;
  const base = siteBaseUrl.replace(/\/+$/, '');
  return route.startsWith('/') ? `${base}${route}` : `${base}/${route}`;
}

// -------------------------------------------------------------------- matches

export interface MatchMappingContext {
  readonly tournamentId: TournamentId;
  readonly tournamentName: string;
  readonly venueUtcOffsetMinutes: number | null;
  readonly tournamentIsShown: boolean;
}

export function mapMatch(raw: RawMatch, context: MatchMappingContext): ProviderMatch {
  const { status, rawStatus } = mapStatus({
    primary: raw.Status,
    secondary: raw.PulseStatus,
    reason: raw.Reason,
  });

  const [sideOne, sideTwo] = mapCompetitors(raw);

  return {
    id: {
      // Identity is composite: the provider's match id collides across tournaments,
      // and it must never involve the start time, which moves.
      tournament: context.tournamentId,
      providerMatchId: raw.MatchId,
    },
    tournamentName: context.tournamentName,
    sideOne,
    sideTwo,
    schedule: mapSchedule(raw, context.venueUtcOffsetMinutes),
    status,
    rawStatus,
    round: mapRound(raw),
    court: raw.CourtName ?? null,
    // A match-level marker has never been observed, but is honoured if it appears.
    isShownOnTennisTv: raw.metadata?.notShown === true ? false : context.tournamentIsShown,
    isSimulated: false,
    raw,
  };
}

/**
 * Works out when a match starts, or records why we cannot say.
 *
 * Three facts drive this, all measured:
 *  - `MatchDate` at `T00:00:00` means the start time is not published; the date is
 *    still known, which is what day-bucketing needs.
 *  - A published time and a NotBefore time never co-occur (0 of 1868 records).
 *  - Of the NotBefore variants, only `Starts At` is a committed start. `Not Before`
 *    and `Followed By` are not, and an unqualified NotBefore time is ambiguous.
 *
 * Note what this function does NOT do: it never compares anything to the current
 * clock. A start time in the past is not evidence of a delay.
 */
export function mapSchedule(raw: RawMatch, venueUtcOffsetMinutes: number | null): MatchSchedule {
  const onDate = raw.MatchDate.slice(0, 10);
  const timeOfDay = raw.MatchDate.slice(11, 19);
  const notBeforeUtc = mapNotBeforeTime(raw.NotBeforeISOTime, onDate);

  const tbc = (tbcReason: TbcReason): MatchSchedule => ({
    onDate,
    startsAtUtc: null,
    notBeforeUtc,
    tbcReason,
  });

  if (timeOfDay !== '00:00:00') {
    const startsAtUtc = venueWallClockToUtc(raw.MatchDate, venueUtcOffsetMinutes);
    // A published wall clock we cannot place on the timeline is not a start time.
    return startsAtUtc === null
      ? tbc('NO_VENUE_OFFSET')
      : { onDate, startsAtUtc, notBeforeUtc, tbcReason: null };
  }

  const qualifier = (raw.NotBeforeText ?? raw.NotBefore ?? '').trim().toLowerCase();

  if (qualifier === 'starts at' && notBeforeUtc !== null) {
    return { onDate, startsAtUtc: notBeforeUtc, notBeforeUtc, tbcReason: null };
  }
  if (qualifier === 'followed by') return tbc('FOLLOWS_PREVIOUS_MATCH');
  if (notBeforeUtc !== null) return tbc('NOT_BEFORE_ONLY');

  return tbc('NOT_PUBLISHED');
}

/**
 * `NotBeforeISOTime` is a time of day with its own offset and no date (`10:00+0800`).
 * Combined with the match's local date it becomes an absolute instant — and because
 * the offset is explicit, it is a better source than the tournament's.
 */
function mapNotBeforeTime(
  notBeforeIsoTime: string | null | undefined,
  onDate: string,
): Date | null {
  if (typeof notBeforeIsoTime !== 'string' || notBeforeIsoTime === '') return null;

  const parsed = DateTime.fromISO(`${onDate}T${notBeforeIsoTime}`, { setZone: true });
  return parsed.isValid ? parsed.toUTC().toJSDate() : null;
}

/**
 * Venue wall clock plus an offset supplied by the source.
 *
 * Duplicated deliberately from `domain/time.ts`: this one takes the provider's naive
 * string, so keeping it here stops the provider's string format leaking into domain.
 */
function venueWallClockToUtc(isoLocal: string, offsetMinutes: number | null): Date | null {
  if (offsetMinutes === null) return null;

  const parsed = DateTime.fromISO(isoLocal, { zone: FixedOffsetZone.instance(offsetMinutes) });
  return parsed.isValid ? parsed.toUTC().toJSDate() : null;
}

/**
 * Competitors, from whichever of the two record shapes this is.
 *
 * Result records carry `PlayerTeam1`/`PlayerTeam2`; order-of-play records carry
 * `TeamsInMatch`. Doubles pairs and undecided opponents both occur.
 */
function mapCompetitors(raw: RawMatch): [Competitor, Competitor] {
  if (raw.PlayerTeam1 || raw.PlayerTeam2) {
    return [fromPlayerTeam(raw.PlayerTeam1), fromPlayerTeam(raw.PlayerTeam2)];
  }

  const teams = raw.TeamsInMatch ?? [];
  return [fromTeam(teams[0]), fromTeam(teams[1])];
}

type PlayerTeam = NonNullable<RawMatch['PlayerTeam1']>;
type TeamInMatch = NonNullable<RawMatch['TeamsInMatch']>[number];

const UNDECIDED = 'TBD';

function fromPlayerTeam(team: PlayerTeam | null | undefined): Competitor {
  if (!team) return { name: UNDECIDED, isKnown: false };

  const names = [
    joinName(team.PlayerFirstName, team.PlayerLastName),
    joinName(team.PartnerFirstName, team.PartnerLastName),
  ].filter((name) => name !== '');

  if (names.length === 0) return { name: UNDECIDED, isKnown: false };
  return { name: names.join(' / '), isKnown: true };
}

function fromTeam(team: TeamInMatch | undefined): Competitor {
  if (!team) return { name: UNDECIDED, isKnown: false };

  const names = (team.Players ?? [])
    .map((player) => joinName(player.FirstName, player.LastName))
    .filter((name) => name !== '');

  if (names.length === 0) return { name: team.TeamCode ?? UNDECIDED, isKnown: false };

  const label =
    team.TeamCode === null || team.TeamCode === undefined
      ? names.join(' / ')
      : `${names.join(' / ')} (${team.TeamCode})`;

  // `IsKnown: false` marks a slot awaiting a result; treat a missing flag as known,
  // since 1868 records carried names whenever they carried a team.
  return { name: label, isKnown: team.IsKnown !== false };
}

function joinName(first: string | null | undefined, last: string | null | undefined): string {
  return [first, last]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join(' ');
}

function mapRound(raw: RawMatch): string | null {
  const round = raw.Round;
  if (!round) return null;
  return round.LongName ?? round.RoundName ?? round.ShortName ?? null;
}
