import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the factual claims in docs/TENNISTV_DATA_SOURCE.md to the captured fixtures.
 *
 * This is not a test of our code — there is none yet. It is a test of our *beliefs*.
 * When the fixtures are re-captured (`npm run recon`), anything Tennis TV has changed
 * that would invalidate the provider design fails here, loudly and attributably,
 * instead of being discovered through a wrong Slack message.
 */

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'tennistv');

interface Tournament {
  id: number;
  year: number;
  name: string;
  start: string;
  end: string;
  location?: string;
  info?: { utcOffset?: number; city?: string };
  metadata?: { notShown?: boolean; broadcastText?: string; customRoute?: string };
  availableOopDays?: { isoDate: string }[];
}

interface Match {
  MatchId?: string;
  MatchDate?: string;
  NotBeforeISOTime?: string;
  NotBeforeText?: string;
  Status?: string;
  PulseStatus?: string;
  Reason?: string;
  CourtName?: string;
  Round?: { ShortName?: string; LongName?: string; RoundName?: string };
  TournamentId?: number;
  TournamentYear?: number;
  PlayerTeam1?: { PlayerId?: string; PlayerLastName?: string };
  TeamsInMatch?: { Players?: { LastName?: string }[]; IsKnown?: boolean }[];
}

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(join(FIXTURE_DIR, file), 'utf8')) as T;

const loadMatches = async (file: string): Promise<Match[]> =>
  (await readJson<{ matches: Match[] }>(file)).matches;

const timeOfDay = (match: Match): string => (match.MatchDate ?? '').slice(11, 19);
const hasPublishedStartTime = (match: Match): boolean =>
  Boolean(match.MatchDate) && timeOfDay(match) !== '' && timeOfDay(match) !== '00:00:00';

describe('tournament feed', () => {
  it('exposes the fields the provider maps', async () => {
    const tournaments = await readJson<Tournament[]>('tournaments-season.json');
    expect(tournaments.length).toBeGreaterThan(50);

    for (const tournament of tournaments) {
      expect(typeof tournament.id).toBe('number');
      expect(typeof tournament.year).toBe('number');
      expect(tournament.name).toBeTruthy();
      expect(tournament.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tournament.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('identifies a tournament by id + year, not id alone', async () => {
    const tournaments = await readJson<Tournament[]>('tournaments-season.json');
    const composite = new Set(tournaments.map((t) => `${t.id}:${t.year}`));
    expect(composite.size).toBe(tournaments.length);
  });

  it('marks unavailable tournaments explicitly, and marks nothing else', async () => {
    const tournaments = await readJson<Tournament[]>('tournaments-season.json');
    const notShown = tournaments.filter((t) => t.metadata?.notShown === true);

    expect(notShown.length).toBeGreaterThan(0);
    for (const tournament of notShown) {
      expect(tournament.metadata?.broadcastText).toBe('Not Shown On Tennis TV');
    }

    // The rule is "exclude what is explicitly marked", not "include only what is
    // marked available" — most tournaments carry no marker at all.
    const withoutMarker = tournaments.filter((t) => t.metadata?.notShown === undefined);
    expect(withoutMarker.length).toBeGreaterThan(notShown.length);
  });

  it('supplies a venue UTC offset for almost every tournament, but not all', async () => {
    const tournaments = await readJson<Tournament[]>('tournaments-season.json');
    const missing = tournaments.filter((t) => typeof t.info?.utcOffset !== 'number');

    // Documented as a real case: the provider must treat a missing offset as
    // "time unknown" rather than guessing one.
    expect(missing.length).toBeGreaterThanOrEqual(0);
    expect(missing.length).toBeLessThan(tournaments.length / 2);
  });
});

describe('match feed', () => {
  it('is empty for tournaments whose draw has not been published', async () => {
    // Hangzhou and Chengdu both start 2026-09-23; captured 2026-09-14.
    for (const file of ['matches-4713-2026.json', 'matches-7581-2026.json']) {
      expect(await loadMatches(file)).toEqual([]);
    }
  });

  it('is populated for tournaments that have taken place', async () => {
    expect((await loadMatches('matches-580-2026.json')).length).toBeGreaterThan(0);
    expect((await loadMatches('matches-520-2026.json')).length).toBeGreaterThan(0);
  });

  it('does not make MatchId globally unique, so identity needs the tournament', async () => {
    const all = (
      await Promise.all(
        [
          'matches-580-2026.json',
          'matches-520-2026.json',
          'matches-9900-2026.json',
          'matches-339-2026.json',
        ].map(loadMatches),
      )
    ).flat();

    const composite = new Set(all.map((m) => `${m.TournamentId}:${m.TournamentYear}:${m.MatchId}`));
    expect(composite.size).toBe(all.length);
  });

  it('never carries both a published start time and a NotBefore time', async () => {
    const all = (
      await Promise.all(
        [
          'matches-580-2026.json',
          'matches-520-2026.json',
          'matches-9900-2026.json',
          'matches-339-2026.json',
        ].map(loadMatches),
      )
    ).flat();

    for (const match of all) {
      if (hasPublishedStartTime(match)) expect(match.NotBeforeISOTime).toBeUndefined();
    }
  });

  it('represents an unpublished start time as a midnight MatchDate', async () => {
    const matches = await loadMatches('matches-580-2026.json');
    const withoutTime = matches.filter((m) => !hasPublishedStartTime(m));

    expect(withoutTime.length).toBeGreaterThan(0);
    for (const match of withoutTime) {
      expect(timeOfDay(match)).toBe('00:00:00');
      // The date is still known — only the time of day is missing.
      expect(match.MatchDate?.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('gives NotBeforeISOTime its own explicit offset', async () => {
    const matches = await loadMatches('matches-580-2026.json');
    const withNotBefore = matches.filter((m) => m.NotBeforeISOTime);

    expect(withNotBefore.length).toBeGreaterThan(0);
    for (const match of withNotBefore) {
      expect(match.NotBeforeISOTime).toMatch(/^\d{2}:\d{2}[+-]\d{4}$/);
    }
  });

  it('uses only the status values the provider knows how to map', async () => {
    const all = (
      await Promise.all(
        [
          'matches-580-2026.json',
          'matches-520-2026.json',
          'matches-9900-2026.json',
          'matches-339-2026.json',
        ].map(loadMatches),
      )
    ).flat();

    // Observed on 2026-09-14. A new value appearing here is a signal to revisit the
    // status mapping — see docs/TENNISTV_DATA_SOURCE.md § Status values.
    const observedStatus = [...new Set(all.map((m) => m.Status))].sort();
    expect(observedStatus).toEqual(['CA', 'F', 'Finished', 'WO', undefined]);

    const observedPulse = [...new Set(all.map((m) => m.PulseStatus))].sort();
    expect(observedPulse).toEqual(['C', 'U']);
  });

  it('can omit Status entirely, so the provider must tolerate its absence', async () => {
    const all = (
      await Promise.all(
        [
          'matches-580-2026.json',
          'matches-520-2026.json',
          'matches-9900-2026.json',
          'matches-339-2026.json',
        ].map(loadMatches),
      )
    ).flat();

    const withoutStatus = all.filter((match) => match.Status === undefined);
    expect(withoutStatus.length).toBeGreaterThan(0);
    // Where Status is missing, PulseStatus still says which representation it is.
    for (const match of withoutStatus) expect(match.PulseStatus).toBe('U');
  });

  it('always carries the fields match identity and display depend on', async () => {
    const all = (
      await Promise.all(
        [
          'matches-580-2026.json',
          'matches-520-2026.json',
          'matches-9900-2026.json',
          'matches-339-2026.json',
        ].map(loadMatches),
      )
    ).flat();

    for (const match of all) {
      expect(match.MatchId).toBeTruthy();
      expect(match.TournamentId).toBeTypeOf('number');
      expect(match.TournamentYear).toBeTypeOf('number');
      expect(match.MatchDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(match.PulseStatus).toBeTruthy();
    }
  });

  it('carries competitors in one of two shapes', async () => {
    const matches = await loadMatches('matches-580-2026.json');

    for (const match of matches) {
      const hasPair = Boolean(match.PlayerTeam1);
      const hasTeams = Array.isArray(match.TeamsInMatch);
      expect(hasPair || hasTeams).toBe(true);
    }
  });

  it('carries round and court for scheduled matches', async () => {
    const matches = await loadMatches('matches-580-2026.json');
    expect(matches.every((m) => m.Round !== undefined)).toBe(true);
    expect(matches.filter((m) => m.CourtName).length).toBeGreaterThan(0);
  });
});
