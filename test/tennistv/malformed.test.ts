import { afterEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../src/logging/logger.ts';
import {
  TennisTvInvalidJsonError,
  TennisTvSchemaError,
  isTennisTvError,
} from '../../src/tennistv/errors.ts';
import { HttpTennisTvProvider } from '../../src/tennistv/http-provider.ts';
import { rawMatchSchema, rawTournamentSchema } from '../../src/tennistv/schemas.ts';

/**
 * What the provider does with responses it does not understand.
 *
 * The rule throughout: **never interpret malformed data**. A response the provider
 * cannot parse must produce a loud, attributable failure — not a half-populated
 * schedule, not a silently empty day, and never a guess.
 */

let requested: string[] = [];
let handler: (path: string) => Response = () => new Response('[]');

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

globalThis.fetch = vi.fn((input: string | URL | Request) => {
  const url = new URL(urlOf(input));
  requested.push(`${url.pathname}${url.search}`);
  return Promise.resolve(handler(`${url.pathname}${url.search}`));
});

afterEach(() => {
  requested = [];
  handler = () => new Response('[]');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const raw = (body: string, contentType = 'application/json'): Response =>
  new Response(body, { headers: { 'content-type': contentType } });

const provider = (): HttpTennisTvProvider =>
  new HttpTennisTvProvider({
    apiBaseUrl: 'https://api.example.test',
    siteBaseUrl: 'https://www.tennistv.com',
    accountId: '35',
    logger: silentLogger(),
    http: { maxAttempts: 1 },
  });

const aTournament = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 4713,
  year: 2026,
  name: 'Hangzhou',
  start: '2026-09-23',
  end: '2026-09-29',
  info: { utcOffset: 8 },
  ...overrides,
});

const aMatch = (overrides: Record<string, unknown> = {}): unknown => ({
  MatchId: 'MS001',
  MatchDate: '2026-09-23T11:00:00',
  PulseStatus: 'U',
  Status: 'U',
  TournamentId: 4713,
  TournamentYear: 2026,
  ...overrides,
});

const range = { from: '2026-09-01', to: '2026-09-30' };
const tournamentId = { providerTournamentId: '4713', year: 2026 };

describe('responses that are not JSON at all', () => {
  it('rejects an HTML maintenance page served as JSON', async () => {
    handler = () => raw('<html><body>We are down for maintenance</body></html>');

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvInvalidJsonError);
  });

  it('rejects a truncated body', async () => {
    handler = () => raw('[{"id":4713,"year":20');

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvInvalidJsonError);
  });

  it('rejects an empty body', async () => {
    handler = () => raw('');

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvInvalidJsonError);
  });

  it('names the path, so the failure can be reproduced', async () => {
    handler = () => raw('not json');

    const error = await provider()
      .getTournaments(range)
      .catch((caught: unknown) => caught);

    expect(isTennisTvError(error)).toBe(true);
    expect((error as Error).message).toContain('/tennis/v1/tournaments');
  });
});

describe('responses whose top-level shape is wrong', () => {
  it('rejects a tournament listing that is no longer an array', async () => {
    handler = () => json({ tournaments: [aTournament()] });

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvSchemaError);
  });

  it('rejects a tournament listing that is a bare string', async () => {
    handler = () => json('nope');

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvSchemaError);
  });

  it('rejects a match response that is an array rather than an envelope', async () => {
    handler = () => json([aMatch()]);

    await expect(provider().getTournamentMatches(tournamentId)).rejects.toBeInstanceOf(
      TennisTvSchemaError,
    );
  });

  it('treats a null matches field as empty rather than failing', async () => {
    // Distinct from malformed: an explicit null is the source saying "nothing here".
    handler = () => json({ matches: null, tournaments: [] });

    const snapshot = await provider().getTournamentMatches(tournamentId);
    expect(snapshot.matches).toEqual([]);
  });
});

describe('records with the wrong field types', () => {
  it('rejects a tournament whose id became a string', async () => {
    handler = () => json([aTournament({ id: '4713' })]);

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvSchemaError);
  });

  it('rejects a tournament whose dates are no longer ISO dates', async () => {
    handler = () => json([aTournament({ start: '23/09/2026' })]);

    await expect(provider().getTournaments(range)).rejects.toBeInstanceOf(TennisTvSchemaError);
  });

  it('rejects a match whose date gained a timezone', async () => {
    // A zone on MatchDate would change its meaning entirely; better to fail than to
    // reinterpret a venue wall clock as UTC.
    handler = () =>
      json({
        matches: [aMatch({ MatchDate: '2026-09-23T11:00:00Z' })],
        tournaments: [aTournament()],
      });

    await expect(provider().getTournamentMatches(tournamentId)).rejects.toBeInstanceOf(
      TennisTvSchemaError,
    );
  });

  it('rejects a not-before time in an unrecognised format', async () => {
    handler = () =>
      json({
        matches: [aMatch({ NotBeforeISOTime: '10:00 AM' })],
        tournaments: [aTournament()],
      });

    await expect(provider().getTournamentMatches(tournamentId)).rejects.toBeInstanceOf(
      TennisTvSchemaError,
    );
  });

  it('accepts an unknown extra field, which is not a breakage', async () => {
    // Tennis TV adds fields without telling us; a strict object would turn a harmless
    // addition into an outage.
    handler = () => json([aTournament({ somethingNew: { nested: true } })]);

    const snapshot = await provider().getTournaments(range);
    expect(snapshot.tournaments).toHaveLength(1);
    expect(snapshot.skipped).toBe(0);
  });
});

describe('partial drift', () => {
  it('skips a few bad records and reports the count', async () => {
    const matches = [
      ...Array.from({ length: 30 }, (_, index) => aMatch({ MatchId: `OK${String(index)}` })),
      { MatchId: 'BAD', MatchDate: 'nonsense', PulseStatus: 'U' },
    ];
    handler = () => json({ matches, tournaments: [aTournament()] });

    const snapshot = await provider().getTournamentMatches(tournamentId);

    expect(snapshot.matches).toHaveLength(30);
    expect(snapshot.skipped).toBe(1);
  });

  it('fails rather than report a mostly-empty schedule as the truth', async () => {
    const matches = [aMatch(), { MatchId: 'BAD1' }, { MatchId: 'BAD2' }];
    handler = () => json({ matches, tournaments: [aTournament()] });

    await expect(provider().getTournamentMatches(tournamentId)).rejects.toBeInstanceOf(
      TennisTvSchemaError,
    );
  });

  it('never retries a shape it does not understand', async () => {
    handler = () => json({ matches: [{ nope: 1 }, { nope: 2 }], tournaments: [] });

    const error = await provider()
      .getTournamentMatches(tournamentId)
      .catch((caught: unknown) => caught);

    expect((error as TennisTvSchemaError).retryable).toBe(false);
    // One attempt, because asking again cannot change the answer.
    expect(requested).toHaveLength(1);
  });
});

/** A match record with one field removed, for asserting what is genuinely required. */
const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(aMatch() as Record<string, unknown>).filter(([key]) => key !== field),
  );

describe('the schema itself', () => {
  it('requires only what the provider genuinely cannot work without', () => {
    // Observed on every one of 1868 captured records.
    expect(rawMatchSchema.safeParse(aMatch()).success).toBe(true);

    // Rebuilt without the field rather than deleted from a copy, which keeps the
    // objects plain and the intent obvious.
    for (const required of ['MatchId', 'MatchDate', 'PulseStatus', 'TournamentId']) {
      expect(
        rawMatchSchema.safeParse(without(required)).success,
        `${required} should be required`,
      ).toBe(false);
    }
  });

  it('tolerates a missing Status, which was observed once in 1868 records', () => {
    expect(rawMatchSchema.safeParse(without('Status')).success).toBe(true);
  });

  it('tolerates a tournament with no metadata and no location', () => {
    // 20 of 81 captured tournaments carry no metadata at all.
    expect(rawTournamentSchema.safeParse(aTournament()).success).toBe(true);
  });

  it('tolerates a tournament with no venue offset', () => {
    const parsed = rawTournamentSchema.safeParse(aTournament({ info: { city: 'Nowhere' } }));
    expect(parsed.success).toBe(true);
  });
});

describe('the diagnostic a schema failure produces', () => {
  it('says what broke, where, how much, and what to do', async () => {
    handler = () => json({ matches: [{ MatchId: 'X' }, { MatchId: 'Y' }], tournaments: [] });

    const error = (await provider()
      .getTournamentMatches(tournamentId)
      .catch((caught: unknown) => caught)) as TennisTvSchemaError;

    expect(error.message).toContain('match records');
    expect(error.message).toContain('/tennis/v1/matches?tournamentId=4713&year=2026');
    expect(error.message).toContain('Rejected 2 of 2');
    expect(error.message).toContain('MatchDate');
    expect(error.message).toContain('npm run recon');
    expect(error.message).toContain('src/tennistv/schemas.ts');
  });

  it('reports each distinct problem once, not once per record', async () => {
    const matches = Array.from({ length: 20 }, (_, index) => ({ MatchId: `X${String(index)}` }));
    handler = () => json({ matches, tournaments: [] });

    const error = (await provider()
      .getTournamentMatches(tournamentId)
      .catch((caught: unknown) => caught)) as TennisTvSchemaError;

    expect(error.rejected).toBe(20);
    expect(error.issues.length).toBeLessThan(10);
  });

  it('carries an example of the record it could not read', async () => {
    handler = () => json({ matches: [{ MatchId: 'ODD' }, { MatchId: 'ODD2' }], tournaments: [] });

    const error = (await provider()
      .getTournamentMatches(tournamentId)
      .catch((caught: unknown) => caught)) as TennisTvSchemaError;

    expect(error.message).toContain('ODD');
  });
});
