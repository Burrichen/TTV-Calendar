/**
 * Step 3 of reconnaissance: capture and analyse real payloads.
 *
 * Answers the questions in the prompt with evidence rather than assumption:
 *  - which fields exist on tournaments and matches
 *  - which identifiers are stable and unique
 *  - how times are represented, and when they are published
 *  - the real status vocabulary, tallied from data rather than read off the bundle
 *  - which tournaments are marked as not shown on Tennis TV
 */

import { apiGet, describe, type ApiConfig, type ProbeResult } from './probe-api.ts';
import { fieldInventory, tally, uniqueness, type FieldFact } from './lib/analyse.ts';

export type TournamentPhase = 'past' | 'in-progress' | 'soon' | 'later' | 'far';

export interface TournamentRow {
  id: number;
  year: number;
  name: string;
  location?: string;
  start: string;
  end: string;
  type?: string;
  gender?: string;
  notShown: boolean;
  broadcastText?: string;
  customRoute?: string;
  utcOffset?: number;
  oopDayCount: number;
  daysUntilStart: number;
  phase: TournamentPhase;
}

export interface MatchSampleReport {
  tournament: TournamentRow;
  request: ProbeResult;
  matchCount: number;
  /** Do match records exist at all this far ahead? */
  matchesPublished: boolean;
  withMatchDate: number;
  withTimeOfDay: number;
  withMidnightTime: number;
  withNotBefore: number;
  distinctTimesOfDay: string[];
  statusTally: Record<string, number>;
  pulseStatusTally: Record<string, number>;
  reasonTally: Record<string, number>;
  roundsSeen: string[];
  courtsSeen: string[];
  matchIdSample: string[];
  matchIdUnique: boolean;
  matchLevelMetadataCount: number;
}

export interface CaptureResult {
  capturedAt: string;
  today: string;
  seasonWindow: { from: string; to: string };
  tournamentCount: number;
  listingPages: ProbeResult[];
  tournamentFields: FieldFact[];
  tournamentInfoFields: FieldFact[];
  tournamentMetadataFields: FieldFact[];
  tournamentIdUniqueness: ReturnType<typeof uniqueness>;
  notShownTournaments: TournamentRow[];
  phaseBreakdown: Record<string, number>;
  matchFields: FieldFact[];
  matchSamples: MatchSampleReport[];
  aggregateStatusTally: Record<string, number>;
  aggregatePulseStatusTally: Record<string, number>;
  aggregateReasonTally: Record<string, number>;
  rawTournaments: unknown[];
  rawMatchesByTournament: Record<string, unknown[]>;
}

interface RawTournament {
  id: number;
  year: number;
  name: string;
  location?: string;
  start: string;
  end: string;
  type?: string;
  gender?: string;
  info?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  availableOopDays?: unknown[];
}

interface RawMatch {
  MatchId?: string;
  MatchDate?: string;
  NotBeforeISOTime?: string;
  Status?: string;
  PulseStatus?: string;
  Reason?: string;
  CourtName?: string;
  Round?: { ShortName?: string; LongName?: string };
  metadata?: Record<string, unknown>;
}

const DAY_MS = 86_400_000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function classify(
  row: { start: string; end: string },
  today: string,
): { phase: TournamentPhase; daysUntilStart: number } {
  const days = Math.round(
    (Date.parse(`${row.start}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
  if (row.end < today) return { phase: 'past', daysUntilStart: days };
  if (row.start <= today) return { phase: 'in-progress', daysUntilStart: days };
  if (days <= 14) return { phase: 'soon', daysUntilStart: days };
  if (days <= 60) return { phase: 'later', daysUntilStart: days };
  return { phase: 'far', daysUntilStart: days };
}

function toRow(raw: RawTournament, today: string): TournamentRow {
  const metadata = raw.metadata ?? {};
  const info = raw.info ?? {};
  const { phase, daysUntilStart } = classify(raw, today);
  return {
    id: raw.id,
    year: raw.year,
    name: raw.name,
    ...(typeof raw.location === 'string' ? { location: raw.location } : {}),
    start: raw.start,
    end: raw.end,
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.gender ? { gender: raw.gender } : {}),
    notShown: metadata.notShown === true,
    ...(typeof metadata.broadcastText === 'string'
      ? { broadcastText: metadata.broadcastText }
      : {}),
    ...(typeof metadata.customRoute === 'string' ? { customRoute: metadata.customRoute } : {}),
    ...(typeof info.utcOffset === 'number' ? { utcOffset: info.utcOffset } : {}),
    oopDayCount: Array.isArray(raw.availableOopDays) ? raw.availableOopDays.length : 0,
    daysUntilStart,
    phase,
  };
}

/** Picks tournaments spanning every phase, always including a not-shown example. */
function pickSample(rows: TournamentRow[]): TournamentRow[] {
  const chosen = new Map<string, TournamentRow>();
  const key = (row: TournamentRow) => `${row.id}:${row.year}`;

  for (const phase of ['past', 'in-progress', 'soon', 'later', 'far'] as const) {
    const inPhase = rows.filter((row) => row.phase === phase && !row.notShown);
    for (const row of inPhase.slice(0, phase === 'soon' ? 3 : 2)) chosen.set(key(row), row);
  }
  const notShown = rows.filter((row) => row.notShown);
  for (const row of notShown.slice(0, 2)) chosen.set(key(row), row);

  return [...chosen.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * The API caps `size` at 250 (verified: size=300 returns HTTP 400 "size: must be less
 * than or equal to 250"), so the list is paged rather than requested in one shot.
 */
const MAX_PAGE_SIZE = 250;

async function listAllTournaments(
  config: ApiConfig,
  window: { from: string; to: string },
): Promise<{ tournaments: RawTournament[]; pages: ProbeResult[] }> {
  const tournaments: RawTournament[] = [];
  const pages: ProbeResult[] = [];

  for (let page = 0; page < 20; page += 1) {
    const path = `/tournaments?from=${window.from}&to=${window.to}&size=${MAX_PAGE_SIZE}&page=${page}`;
    const response = await apiGet(config, path);
    pages.push(describe(`tournaments page ${page}`, path, response));

    if (!response.ok) {
      throw new Error(
        `Tournament listing failed: HTTP ${response.status} for ${path}. ` +
          `Body: ${JSON.stringify(response.json).slice(0, 200)}`,
      );
    }
    const batch = Array.isArray(response.json) ? (response.json as RawTournament[]) : [];
    tournaments.push(...batch);
    if (batch.length < MAX_PAGE_SIZE) break;
  }

  return { tournaments, pages };
}

export async function capture(config: ApiConfig, today: string): Promise<CaptureResult> {
  const year = Number(today.slice(0, 4));
  const seasonWindow = { from: `${year}-01-01`, to: `${year + 1}-03-31` };

  const { tournaments: rawTournaments, pages } = await listAllTournaments(config, seasonWindow);
  const rows = rawTournaments.map((raw) => toRow(raw, today));

  const sample = pickSample(rows);
  const matchSamples: MatchSampleReport[] = [];
  const rawMatchesByTournament: Record<string, unknown[]> = {};
  const allMatches: RawMatch[] = [];

  for (const tournament of sample) {
    const path = `/matches?tournamentId=${tournament.id}&year=${tournament.year}`;
    const response = await apiGet(config, path);
    const body = response.json as { matches?: RawMatch[] } | undefined;
    const matches = Array.isArray(body?.matches) ? body.matches : [];

    rawMatchesByTournament[`${tournament.id}-${tournament.year}`] = matches;
    allMatches.push(...matches);

    const timesOfDay = matches
      .map((match) => (match.MatchDate ?? '').slice(11, 19))
      .filter((time) => time !== '');

    matchSamples.push({
      tournament,
      request: describe(`matches for ${tournament.name} ${tournament.year}`, path, response),
      matchCount: matches.length,
      matchesPublished: matches.length > 0,
      withMatchDate: matches.filter((match) => Boolean(match.MatchDate)).length,
      withTimeOfDay: timesOfDay.filter((time) => time !== '00:00:00').length,
      withMidnightTime: timesOfDay.filter((time) => time === '00:00:00').length,
      withNotBefore: matches.filter((match) => Boolean(match.NotBeforeISOTime)).length,
      distinctTimesOfDay: [...new Set(timesOfDay)].sort().slice(0, 12),
      statusTally: tally(matches, (match) => match.Status),
      pulseStatusTally: tally(matches, (match) => match.PulseStatus),
      reasonTally: tally(matches, (match) => match.Reason),
      roundsSeen: [
        ...new Set(matches.map((match) => match.Round?.ShortName).filter(Boolean) as string[]),
      ],
      courtsSeen: [
        ...new Set(matches.map((match) => match.CourtName).filter(Boolean) as string[]),
      ].slice(0, 10),
      matchIdSample: matches.slice(0, 4).map((match) => match.MatchId ?? '(missing)'),
      matchIdUnique: uniqueness(matches, (match) => match.MatchId).unique,
      matchLevelMetadataCount: matches.filter((match) => match.metadata !== undefined).length,
    });
  }

  const phaseBreakdown = tally(rows, (row) => row.phase);

  return {
    capturedAt: new Date().toISOString(),
    today,
    seasonWindow,
    tournamentCount: rows.length,
    listingPages: pages,
    tournamentFields: fieldInventory(rawTournaments),
    tournamentInfoFields: fieldInventory(rawTournaments.map((raw) => raw.info ?? {})),
    tournamentMetadataFields: fieldInventory(rawTournaments.map((raw) => raw.metadata ?? {})),
    tournamentIdUniqueness: uniqueness(rows, (row) => `${row.id}:${row.year}`),
    notShownTournaments: rows.filter((row) => row.notShown),
    phaseBreakdown,
    matchFields: fieldInventory(allMatches),
    matchSamples,
    aggregateStatusTally: tally(allMatches, (match) => match.Status),
    aggregatePulseStatusTally: tally(allMatches, (match) => match.PulseStatus),
    aggregateReasonTally: tally(allMatches, (match) => match.Reason),
    rawTournaments,
    rawMatchesByTournament,
  };
}

export { isoDate };
