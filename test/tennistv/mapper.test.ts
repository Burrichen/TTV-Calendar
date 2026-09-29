import { describe, expect, it } from 'vitest';

import { mapMatch, mapSchedule, mapTournament } from '../../src/tennistv/mapper.ts';
import { rawMatchSchema, rawTournamentSchema } from '../../src/tennistv/schemas.ts';
import type { RawMatch, RawTournament } from '../../src/tennistv/schemas.ts';

const OPTIONS = { siteBaseUrl: 'https://www.tennistv.com' };

const CONTEXT = {
  tournamentId: { providerTournamentId: '560', year: 2026 },
  tournamentName: 'US Open',
  venueUtcOffsetMinutes: -4 * 60,
  tournamentIsShown: true,
};

const rawMatch = (overrides: Partial<RawMatch> = {}): RawMatch =>
  rawMatchSchema.parse({
    MatchId: 'MS001',
    MatchDate: '2026-08-24T11:00:00',
    PulseStatus: 'U',
    Status: 'U',
    TournamentId: 560,
    TournamentYear: 2026,
    ...overrides,
  });

const rawTournament = (overrides: Partial<RawTournament> = {}): RawTournament =>
  rawTournamentSchema.parse({
    id: 4713,
    year: 2026,
    name: 'Hangzhou',
    start: '2026-09-23',
    end: '2026-09-29',
    location: 'China',
    info: { city: 'Hangzhou', utcOffset: 8 },
    metadata: { customRoute: '/tournaments/hangzhou-open' },
    ...overrides,
  });

describe('mapTournament', () => {
  it('maps the fields the bot needs', () => {
    const tournament = mapTournament(rawTournament(), OPTIONS);

    expect(tournament.id).toEqual({ providerTournamentId: '4713', year: 2026 });
    expect(tournament.name).toBe('Hangzhou');
    expect(tournament.location).toBe('China');
    expect(tournament.city).toBe('Hangzhou');
    expect(tournament.startsOn).toBe('2026-09-23');
    expect(tournament.endsOn).toBe('2026-09-29');
  });

  it('retains a source URL built from the provider route', () => {
    expect(mapTournament(rawTournament(), OPTIONS).sourceUrl).toBe(
      'https://www.tennistv.com/tournaments/hangzhou-open',
    );
  });

  it('has no source URL when the provider gives no route', () => {
    // Better an honest null than a URL we guessed and that 404s.
    const tournament = mapTournament(rawTournament({ metadata: {} }), OPTIONS);
    expect(tournament.sourceUrl).toBeNull();
  });

  describe('availability', () => {
    it('excludes a tournament explicitly marked as not shown', () => {
      const tournament = mapTournament(
        rawTournament({
          metadata: { notShown: true, broadcastText: 'Not Shown On Tennis TV' },
        }),
        OPTIONS,
      );

      expect(tournament.isShownOnTennisTv).toBe(false);
      expect(tournament.notShownReason).toBe('Not Shown On Tennis TV');
    });

    it('includes a tournament with no metadata at all', () => {
      // 20 of 81 observed tournaments carry no metadata. Absence means shown.
      const tournament = mapTournament(rawTournament({ metadata: undefined }), OPTIONS);
      expect(tournament.isShownOnTennisTv).toBe(true);
      expect(tournament.notShownReason).toBeNull();
    });

    it('includes a tournament marked explicitly as shown', () => {
      const tournament = mapTournament(rawTournament({ metadata: { notShown: false } }), OPTIONS);
      expect(tournament.isShownOnTennisTv).toBe(true);
    });
  });

  describe('venue offset', () => {
    it('converts decimal hours to minutes', () => {
      expect(
        mapTournament(rawTournament({ info: { utcOffset: 8 } }), OPTIONS).venueUtcOffsetMinutes,
      ).toBe(480);
    });

    it('handles a negative offset', () => {
      expect(
        mapTournament(rawTournament({ info: { utcOffset: -4 } }), OPTIONS).venueUtcOffsetMinutes,
      ).toBe(-240);
    });

    it('handles a half-hour offset', () => {
      expect(
        mapTournament(rawTournament({ info: { utcOffset: 5.5 } }), OPTIONS).venueUtcOffsetMinutes,
      ).toBe(330);
    });

    it('is null when the provider omits it', () => {
      // Observed on 1 of 81 tournaments. Never substitute a default.
      expect(
        mapTournament(rawTournament({ info: { city: 'Nowhere' } }), OPTIONS).venueUtcOffsetMinutes,
      ).toBeNull();
    });
  });

  describe('hasPublishedMatches', () => {
    it('is false when no order of play exists', () => {
      expect(mapTournament(rawTournament(), OPTIONS).hasPublishedMatches).toBe(false);
    });

    it('is true once the provider lists order-of-play days', () => {
      const tournament = mapTournament(
        rawTournament({ availableOopDays: [{ isoDate: '2026-09-23' }] }),
        OPTIONS,
      );
      expect(tournament.hasPublishedMatches).toBe(true);
    });

    it('is not fooled by matchesSize, which is only a forecast', () => {
      const tournament = mapTournament(rawTournament({ metadata: { matchesSize: '23' } }), OPTIONS);
      expect(tournament.hasPublishedMatches).toBe(false);
    });
  });
});

describe('mapSchedule', () => {
  describe('published start times', () => {
    it('converts venue wall clock to UTC using the offset from the payload', () => {
      const schedule = mapSchedule(rawMatch({ MatchDate: '2026-08-24T11:00:00' }), -4 * 60);

      expect(schedule.startsAtUtc?.toISOString()).toBe('2026-08-24T15:00:00.000Z');
      expect(schedule.tbcReason).toBeNull();
    });

    it('keeps the venue-local calendar date', () => {
      expect(mapSchedule(rawMatch({ MatchDate: '2026-08-24T23:30:00' }), 8 * 60).onDate).toBe(
        '2026-08-24',
      );
    });

    it('is TBC when the venue offset is unknown, rather than assuming UTC', () => {
      const schedule = mapSchedule(rawMatch({ MatchDate: '2026-08-24T11:00:00' }), null);

      expect(schedule.startsAtUtc).toBeNull();
      expect(schedule.tbcReason).toBe('NO_VENUE_OFFSET');
      expect(schedule.onDate).toBe('2026-08-24');
    });
  });

  describe('unpublished start times', () => {
    it('treats a midnight MatchDate as not published', () => {
      const schedule = mapSchedule(rawMatch({ MatchDate: '2026-01-12T00:00:00' }), 11 * 60);

      expect(schedule.startsAtUtc).toBeNull();
      expect(schedule.tbcReason).toBe('NOT_PUBLISHED');
      // The date is still known, which is what day-bucketing needs.
      expect(schedule.onDate).toBe('2026-01-12');
    });

    it('treats "Followed By" as TBC', () => {
      const schedule = mapSchedule(
        rawMatch({ MatchDate: '2026-01-11T00:00:00', NotBeforeText: 'Followed By' }),
        11 * 60,
      );

      expect(schedule.startsAtUtc).toBeNull();
      expect(schedule.tbcReason).toBe('FOLLOWS_PREVIOUS_MATCH');
    });

    it('treats "Not Before" as TBC while keeping the not-before instant', () => {
      const schedule = mapSchedule(
        rawMatch({
          MatchDate: '2026-01-12T00:00:00',
          NotBeforeISOTime: '11:00+1100',
          NotBeforeText: 'Not Before',
        }),
        11 * 60,
      );

      expect(schedule.startsAtUtc).toBeNull();
      expect(schedule.tbcReason).toBe('NOT_BEFORE_ONLY');
      // Available as context, never promoted to a start time.
      expect(schedule.notBeforeUtc?.toISOString()).toBe('2026-01-12T00:00:00.000Z');
    });

    it('treats an unqualified not-before time as TBC', () => {
      // 333 of 1868 observed records are in this state — the largest group, and the
      // one where guessing would do the most damage.
      const schedule = mapSchedule(
        rawMatch({ MatchDate: '2026-01-12T00:00:00', NotBeforeISOTime: '10:00+1100' }),
        11 * 60,
      );

      expect(schedule.startsAtUtc).toBeNull();
      expect(schedule.tbcReason).toBe('NOT_BEFORE_ONLY');
    });
  });

  describe('"Starts At" is the one committed variant', () => {
    it('uses it as a real start time', () => {
      const schedule = mapSchedule(
        rawMatch({
          MatchDate: '2026-01-12T00:00:00',
          NotBeforeISOTime: '10:00+1100',
          NotBeforeText: 'Starts At',
        }),
        11 * 60,
      );

      expect(schedule.startsAtUtc?.toISOString()).toBe('2026-01-11T23:00:00.000Z');
      expect(schedule.tbcReason).toBeNull();
    });

    it('uses the offset carried by the not-before time, not the tournament offset', () => {
      // NotBeforeISOTime carries its own offset and is the more precise source.
      const schedule = mapSchedule(
        rawMatch({
          MatchDate: '2026-01-12T00:00:00',
          NotBeforeISOTime: '10:00+0800',
          NotBeforeText: 'Starts At',
        }),
        11 * 60,
      );

      expect(schedule.startsAtUtc?.toISOString()).toBe('2026-01-12T02:00:00.000Z');
    });

    it('stays TBC if "Starts At" arrives without a time', () => {
      const schedule = mapSchedule(
        rawMatch({ MatchDate: '2026-01-12T00:00:00', NotBeforeText: 'Starts At' }),
        11 * 60,
      );

      expect(schedule.startsAtUtc).toBeNull();
      expect(schedule.tbcReason).toBe('NOT_PUBLISHED');
    });
  });

  it('never consults the clock — a start in the past is not a delay', () => {
    // PROJECT_SPEC.md §6: delay comes from the provider's status, never from elapsed
    // time. Mapping the same record long after its start must give the same answer.
    const longPast = mapSchedule(rawMatch({ MatchDate: '2020-01-01T11:00:00' }), 0);
    const farFuture = mapSchedule(rawMatch({ MatchDate: '2040-01-01T11:00:00' }), 0);

    expect(longPast.tbcReason).toBeNull();
    expect(farFuture.tbcReason).toBeNull();
    expect(longPast.startsAtUtc?.toISOString()).toBe('2020-01-01T11:00:00.000Z');
  });
});

describe('mapMatch', () => {
  it('builds a composite identity that cannot collide across tournaments', () => {
    const match = mapMatch(rawMatch({ MatchId: 'MS011' }), CONTEXT);

    expect(match.id).toEqual({
      tournament: { providerTournamentId: '560', year: 2026 },
      providerMatchId: 'MS011',
    });
  });

  it('retains the provider status verbatim alongside the normalised one', () => {
    const match = mapMatch(rawMatch({ Status: 'WO', PulseStatus: 'C', Reason: 'W/O' }), CONTEXT);

    expect(match.status).toBe('CANCELLED');
    expect(match.rawStatus).toEqual({
      primary: 'WO',
      secondary: 'C',
      reason: 'W/O',
      unmapped: false,
    });
  });

  it('maps an unrecognised status to UNKNOWN and flags it', () => {
    const match = mapMatch(rawMatch({ Status: 'ZZ' }), CONTEXT);

    expect(match.status).toBe('UNKNOWN');
    expect(match.rawStatus.unmapped).toBe(true);
    expect(match.rawStatus.primary).toBe('ZZ');
  });

  it('inherits availability from the tournament', () => {
    const match = mapMatch(rawMatch(), { ...CONTEXT, tournamentIsShown: false });
    expect(match.isShownOnTennisTv).toBe(false);
  });

  it('honours a match-level not-shown marker over the tournament', () => {
    const match = mapMatch(rawMatch({ metadata: { notShown: true } }), CONTEXT);
    expect(match.isShownOnTennisTv).toBe(false);
  });

  describe('competitors', () => {
    it('reads the result-record shape', () => {
      const match = mapMatch(
        rawMatch({
          PlayerTeam1: { PlayerFirstName: 'Jannik', PlayerLastName: 'Sinner' },
          PlayerTeam2: { PlayerFirstName: 'Carlos', PlayerLastName: 'Alcaraz' },
        }),
        CONTEXT,
      );

      expect(match.sideOne).toEqual({ name: 'Jannik Sinner', isKnown: true });
      expect(match.sideTwo).toEqual({ name: 'Carlos Alcaraz', isKnown: true });
    });

    it('reads a doubles pair', () => {
      const match = mapMatch(
        rawMatch({
          PlayerTeam1: {
            PlayerFirstName: 'A',
            PlayerLastName: 'One',
            PartnerFirstName: 'B',
            PartnerLastName: 'Two',
          },
          PlayerTeam2: { PlayerFirstName: 'C', PlayerLastName: 'Three' },
        }),
        CONTEXT,
      );

      expect(match.sideOne.name).toBe('A One / B Two');
    });

    it('reads the order-of-play shape', () => {
      const match = mapMatch(
        rawMatch({
          TeamsInMatch: [
            { Players: [{ FirstName: 'Alexis', LastName: 'Galarneau' }], IsKnown: true },
            { Players: [{ FirstName: 'Nishesh', LastName: 'Basavareddy' }], IsKnown: true },
          ],
        }),
        CONTEXT,
      );

      expect(match.sideOne.name).toBe('Alexis Galarneau');
      expect(match.sideTwo.name).toBe('Nishesh Basavareddy');
    });

    it('labels a team event with its country code', () => {
      const match = mapMatch(
        rawMatch({
          TeamsInMatch: [
            { TeamCode: 'POL', Players: [{ FirstName: 'Jan', LastName: 'Zielinski' }] },
            { TeamCode: 'SUI', Players: [{ FirstName: 'Jakub', LastName: 'Paul' }] },
          ],
        }),
        CONTEXT,
      );

      expect(match.sideOne.name).toBe('Jan Zielinski (POL)');
    });

    it('marks an undecided opponent rather than inventing a name', () => {
      const match = mapMatch(
        rawMatch({
          TeamsInMatch: [
            { Players: [{ FirstName: 'A', LastName: 'One' }], IsKnown: true },
            { Players: [], IsKnown: false },
          ],
        }),
        CONTEXT,
      );

      expect(match.sideTwo.isKnown).toBe(false);
      expect(match.sideTwo.name).toBe('TBD');
    });

    it('copes with a match carrying no competitor information at all', () => {
      const match = mapMatch(rawMatch(), CONTEXT);

      expect(match.sideOne).toEqual({ name: 'TBD', isKnown: false });
      expect(match.sideTwo).toEqual({ name: 'TBD', isKnown: false });
    });
  });

  it('keeps round and court when the provider supplies them', () => {
    const match = mapMatch(
      rawMatch({
        Round: { ShortName: 'Q1', LongName: 'Qualification Round 1' },
        CourtName: 'Court 13',
      }),
      CONTEXT,
    );

    expect(match.round).toBe('Qualification Round 1');
    expect(match.court).toBe('Court 13');
  });

  it('leaves round and court null rather than substituting a placeholder', () => {
    const match = mapMatch(rawMatch(), CONTEXT);
    expect(match.round).toBeNull();
    expect(match.court).toBeNull();
  });
});
