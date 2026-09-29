import { afterEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../src/logging/logger.ts';
import { TennisTvSchemaError } from '../../src/tennistv/errors.ts';
import { HttpTennisTvProvider } from '../../src/tennistv/http-provider.ts';

/**
 * The provider's own behaviour: paging, caching, and what it does with a response it
 * only partly understands. The network is stubbed; the schemas and mapper are real.
 */

let requested: string[] = [];
let handler: (path: string) => Response = () => new Response('[]');

/** `fetch` accepts three input shapes; read the URL from whichever it is. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

globalThis.fetch = vi.fn((input: string | URL | Request) => {
  const url = new URL(urlOf(input));
  const path = `${url.pathname}${url.search}`;
  requested.push(path);
  return Promise.resolve(handler(path));
});

afterEach(() => {
  requested = [];
  handler = () => new Response('[]');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const provider = (overrides: Record<string, unknown> = {}) =>
  new HttpTennisTvProvider({
    apiBaseUrl: 'https://api.example.test',
    siteBaseUrl: 'https://www.tennistv.com',
    accountId: '35',
    logger: silentLogger(),
    http: { maxAttempts: 1 },
    ...overrides,
  });

const aTournament = (id: number, overrides: Record<string, unknown> = {}): unknown => ({
  id,
  year: 2026,
  name: `Tournament ${String(id)}`,
  start: '2026-09-23',
  end: '2026-09-29',
  location: 'China',
  info: { city: 'Somewhere', utcOffset: 8 },
  ...overrides,
});

const aMatch = (matchId: string, overrides: Record<string, unknown> = {}): unknown => ({
  MatchId: matchId,
  MatchDate: '2026-09-23T11:00:00',
  PulseStatus: 'U',
  Status: 'U',
  TournamentId: 4713,
  TournamentYear: 2026,
  ...overrides,
});

describe('HttpTennisTvProvider', () => {
  describe('requests', () => {
    it('asks only for the window it was given, not a whole season', async () => {
      handler = () => json([]);
      await provider().getTournaments({ from: '2026-09-01', to: '2026-10-15' });

      expect(requested[0]).toContain('from=2026-09-01');
      expect(requested[0]).toContain('to=2026-10-15');
    });

    it('requests the maximum page size the API accepts', async () => {
      // 250 is a measured limit: 300 returns HTTP 400.
      handler = () => json([]);
      await provider().getTournaments({ from: '2026-09-01', to: '2026-09-30' });

      expect(requested[0]).toContain('size=250');
    });

    it('sends both required parameters when fetching matches', async () => {
      handler = () => json({ matches: [], tournaments: [] });
      await provider().getTournamentMatches({ providerTournamentId: '4713', year: 2026 });

      expect(requested[0]).toBe('/tennis/v1/matches?tournamentId=4713&year=2026');
    });
  });

  describe('paging', () => {
    it('follows pages until a short one arrives', async () => {
      const fullPage = Array.from({ length: 250 }, (_, index) => aTournament(index + 1));
      handler = (path) => (path.includes('page=0') ? json(fullPage) : json([aTournament(9999)]));

      const snapshot = await provider().getTournaments({ from: '2026-01-01', to: '2026-12-31' });

      expect(snapshot.tournaments).toHaveLength(251);
      expect(requested).toHaveLength(2);
    });

    it('stops after a single page when the first is short', async () => {
      handler = () => json([aTournament(1)]);
      await provider().getTournaments({ from: '2026-09-01', to: '2026-09-30' });

      expect(requested).toHaveLength(1);
    });
  });

  describe('caching', () => {
    it('serves a repeated tournament window from cache', async () => {
      handler = () => json([aTournament(1)]);
      const subject = provider();
      const range = { from: '2026-09-01', to: '2026-09-30' };

      const first = await subject.getTournaments(range);
      const second = await subject.getTournaments(range);

      expect(first.fromCache).toBe(false);
      expect(second.fromCache).toBe(true);
      expect(requested).toHaveLength(1);
    });

    it('treats a different window as a different request', async () => {
      handler = () => json([aTournament(1)]);
      const subject = provider();

      await subject.getTournaments({ from: '2026-09-01', to: '2026-09-30' });
      await subject.getTournaments({ from: '2026-10-01', to: '2026-10-31' });

      expect(requested).toHaveLength(2);
    });

    it('expires the cache once its TTL passes', async () => {
      // Time is moved, not waited for: no sleeping in the suite.
      let clock = 1_000_000;
      handler = () => json([aTournament(1)]);
      const subject = provider({ tournamentTtlMs: 60_000, now: () => clock });
      const range = { from: '2026-09-01', to: '2026-09-30' };

      await subject.getTournaments(range);
      expect((await subject.getTournaments(range)).fromCache).toBe(true);

      clock += 60_001;
      const afterExpiry = await subject.getTournaments(range);

      expect(afterExpiry.fromCache).toBe(false);
      expect(requested).toHaveLength(2);
    });

    it('serves from cache right up to the moment it expires', async () => {
      let clock = 1_000_000;
      handler = () => json([aTournament(1)]);
      const subject = provider({ tournamentTtlMs: 60_000, now: () => clock });
      const range = { from: '2026-09-01', to: '2026-09-30' };

      await subject.getTournaments(range);
      clock += 59_999;

      expect((await subject.getTournaments(range)).fromCache).toBe(true);
      expect(requested).toHaveLength(1);
    });

    it('never serves live state from cache', async () => {
      // A stale answer here would mean announcing a match minutes late, or announcing
      // one that has since been cancelled.
      handler = () => json({ matches: [aMatch('MS001')], tournaments: [aTournament(4713)] });
      const subject = provider();
      const ids = [{ providerTournamentId: '4713', year: 2026 }];

      const first = await subject.getLiveState(ids);
      const second = await subject.getLiveState(ids);

      expect(first.fromCache).toBe(false);
      expect(second.fromCache).toBe(false);
      expect(requested).toHaveLength(2);
    });

    it('makes no request at all when asked about no tournaments', async () => {
      const snapshot = await provider().getLiveState([]);

      expect(snapshot.matches).toEqual([]);
      expect(requested).toHaveLength(0);
    });

    it('clears its caches when closed', async () => {
      handler = () => json([aTournament(1)]);
      const subject = provider();
      const range = { from: '2026-09-01', to: '2026-09-30' };

      await subject.getTournaments(range);
      subject.close();
      await subject.getTournaments(range);

      expect(requested).toHaveLength(2);
    });
  });

  describe('mapping through the envelope', () => {
    it('uses the tournament in the envelope to place match times on the timeline', async () => {
      handler = () =>
        json({
          matches: [aMatch('MS001', { MatchDate: '2026-09-23T11:00:00' })],
          tournaments: [aTournament(4713, { info: { utcOffset: 8 } })],
        });

      const snapshot = await provider().getTournamentMatches({
        providerTournamentId: '4713',
        year: 2026,
      });

      expect(snapshot.matches[0]?.schedule.startsAtUtc?.toISOString()).toBe(
        '2026-09-23T03:00:00.000Z',
      );
      expect(snapshot.matches[0]?.tournamentName).toBe('Tournament 4713');
    });

    it('reports Time TBC rather than guessing when the envelope has no tournament', async () => {
      handler = () => json({ matches: [aMatch('MS001')], tournaments: [] });

      const snapshot = await provider().getTournamentMatches({
        providerTournamentId: '4713',
        year: 2026,
      });

      expect(snapshot.matches[0]?.schedule.startsAtUtc).toBeNull();
      expect(snapshot.matches[0]?.schedule.tbcReason).toBe('NO_VENUE_OFFSET');
    });

    it('returns an empty list for a tournament with no published draw', async () => {
      // Not an error, and not evidence of cancellation.
      handler = () => json({ matches: [], tournaments: [aTournament(4713)] });

      const snapshot = await provider().getTournamentMatches({
        providerTournamentId: '4713',
        year: 2026,
      });

      expect(snapshot.matches).toEqual([]);
      expect(snapshot.skipped).toBe(0);
    });

    it('handles a null matches field as an empty list', async () => {
      handler = () => json({ matches: null, tournaments: [] });

      expect(
        (await provider().getTournamentMatches({ providerTournamentId: '4713', year: 2026 }))
          .matches,
      ).toEqual([]);
    });
  });

  describe('partial schema drift', () => {
    it('skips a few unparseable records and reports the count', async () => {
      const matches = [
        ...Array.from({ length: 30 }, (_, i) => aMatch(`OK${String(i)}`)),
        { MatchId: 'BAD', MatchDate: 'not-a-date', PulseStatus: 'U' },
      ];
      handler = () => json({ matches, tournaments: [aTournament(4713)] });

      const snapshot = await provider().getTournamentMatches({
        providerTournamentId: '4713',
        year: 2026,
      });

      expect(snapshot.matches).toHaveLength(30);
      expect(snapshot.skipped).toBe(1);
    });

    it('throws once most of a response is unparseable', async () => {
      // A near-empty schedule reported as truth is worse than a loud failure.
      const matches = [aMatch('OK'), { MatchId: 'BAD1' }, { MatchId: 'BAD2' }];
      handler = () => json({ matches, tournaments: [aTournament(4713)] });

      await expect(
        provider().getTournamentMatches({ providerTournamentId: '4713', year: 2026 }),
      ).rejects.toBeInstanceOf(TennisTvSchemaError);
    });

    it('is not retried, because asking again cannot change the shape', async () => {
      handler = () => json({ matches: [{ nope: true }, { nope: true }], tournaments: [] });

      await expect(
        provider().getTournamentMatches({ providerTournamentId: '4713', year: 2026 }),
      ).rejects.toMatchObject({ retryable: false });
    });
  });

  describe('schema error messages', () => {
    it('says what broke, where, how much, and what to do next', async () => {
      handler = () => json({ matches: [{ MatchId: 'X' }, { MatchId: 'Y' }], tournaments: [] });

      const error = await provider()
        .getTournamentMatches({ providerTournamentId: '4713', year: 2026 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TennisTvSchemaError);
      const message = (error as Error).message;

      expect(message).toContain('match records');
      expect(message).toContain('/tennis/v1/matches?tournamentId=4713&year=2026');
      expect(message).toContain('Rejected 2 of 2');
      expect(message).toContain('MatchDate');
      expect(message).toContain('npm run recon');
      expect(message).toContain('src/tennistv/schemas.ts');
    });

    it('reports a listing that is no longer an array', async () => {
      handler = () => json({ tournaments: 'surprise' });

      const error = await provider()
        .getTournaments({ from: '2026-09-01', to: '2026-09-30' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TennisTvSchemaError);
      expect((error as Error).message).toContain('tournament listing');
    });

    it('de-duplicates repeated problems instead of listing them once per record', async () => {
      const matches = Array.from({ length: 20 }, (_, i) => ({ MatchId: `X${String(i)}` }));
      handler = () => json({ matches, tournaments: [] });

      const error = (await provider()
        .getTournamentMatches({ providerTournamentId: '4713', year: 2026 })
        .catch((caught: unknown) => caught)) as TennisTvSchemaError;

      // Twenty records failing the same way is one problem, not twenty.
      expect(error.issues.length).toBeLessThan(10);
      expect(error.rejected).toBe(20);
    });
  });
});
