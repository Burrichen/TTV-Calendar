import { describe, expect, it } from 'vitest';

import { silentLogger } from '../../src/logging/logger.ts';
import { HttpTennisTvProvider } from '../../src/tennistv/http-provider.ts';
import { isTennisTvError } from '../../src/tennistv/errors.ts';
import { syncWindow } from '../../src/sync/windows.ts';

/**
 * The live contract test.
 *
 * Everything else in this suite runs against recorded fixtures, which proves we still
 * understand the payloads we captured. This one talks to Tennis TV and proves we still
 * understand the payloads it is serving *now* — the gap between those two is exactly
 * where a silent breakage lives.
 *
 * It is opt-in because a network test that skips invisibly in CI gives false
 * confidence, and one that fails on a flaky connection gives false alarms:
 *
 *   npm run test:contract
 *
 * Intended as a scheduled CI job (nightly is ample). A failure here is a real signal:
 * Tennis TV has changed something the provider depends on.
 */

const ENABLED = process.env.TENNISTV_CONTRACT === 'live';

const provider = new HttpTennisTvProvider({
  apiBaseUrl: process.env.TENNISTV_API_BASE_URL ?? 'https://api.tennistv.com',
  siteBaseUrl: process.env.TENNISTV_BASE_URL ?? 'https://www.tennistv.com',
  accountId: process.env.TENNISTV_ACCOUNT_ID ?? '35',
  logger: silentLogger(),
  http: { maxAttempts: 2, timeoutMs: 20_000 },
});

/** Turns a provider failure into a message that says what to do about it. */
const explain = (error: unknown): string => {
  if (!isTennisTvError(error)) return String(error);
  return (
    `${error.code}: ${error.message}\n\n` +
    'If this is a schema mismatch, Tennis TV has changed its response shape.\n' +
    'Re-capture with `npm run recon`, then update src/tennistv/schemas.ts and\n' +
    'src/tennistv/mapper.ts, and refresh docs/TENNISTV_DATA_SOURCE.md.'
  );
};

describe.skipIf(!ENABLED)('live Tennis TV contract', () => {
  it('still serves tournaments in the shape the provider expects', async () => {
    const range = syncWindow(new Date(), 'Europe/London');

    const snapshot = await provider.getTournaments(range).catch((error: unknown) => {
      throw new Error(explain(error));
    });

    // The window is ~7 weeks. Outside the off-season it will contain events; the
    // assertion that matters is that nothing was rejected.
    expect(
      snapshot.skipped,
      'Tennis TV returned tournament records the provider could not parse. ' +
        'Run `npm run recon` and compare against docs/TENNISTV_DATA_SOURCE.md §4.',
    ).toBe(0);

    for (const tournament of snapshot.tournaments) {
      expect(tournament.id.providerTournamentId).toBeTruthy();
      expect(tournament.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tournament.endsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof tournament.isShownOnTennisTv).toBe('boolean');
    }
  });

  it('still marks some tournaments as not shown on Tennis TV', async () => {
    // The Grand Slams and the Laver Cup carried this marker at capture time. If it
    // vanishes entirely, either the marker moved or our reading of it is wrong — and
    // the bot would start advertising tennis QA cannot actually test against.
    const snapshot = await provider
      .getTournaments({
        from: `${String(new Date().getUTCFullYear())}-01-01`,
        to: `${String(new Date().getUTCFullYear())}-12-31`,
      })
      .catch((error: unknown) => {
        throw new Error(explain(error));
      });

    const notShown = snapshot.tournaments.filter((t) => !t.isShownOnTennisTv);

    expect(
      notShown.length,
      'No tournament in the current season is marked "not shown on Tennis TV". ' +
        'That marker is how PROJECT_SPEC.md §9 is enforced — verify metadata.notShown ' +
        'still exists (docs/TENNISTV_DATA_SOURCE.md §8).',
    ).toBeGreaterThan(0);
  });

  it('still serves match records in the shape the provider expects', async () => {
    const year = new Date().getUTCFullYear();
    const snapshot = await provider
      .getTournaments({ from: `${String(year)}-01-01`, to: `${String(year)}-12-31` })
      .catch((error: unknown) => {
        throw new Error(explain(error));
      });

    // Pick a tournament the provider says has a published order of play.
    const withMatches = snapshot.tournaments.find((t) => t.hasPublishedMatches);
    expect(
      withMatches,
      'No tournament this season reports a published order of play. Either the season ' +
        'has not started or `availableOopDays` has moved (docs/TENNISTV_DATA_SOURCE.md §7).',
    ).toBeDefined();
    if (withMatches === undefined) return;

    const matches = await provider.getTournamentMatches(withMatches.id).catch((error: unknown) => {
      throw new Error(explain(error));
    });

    expect(
      matches.skipped,
      `Tennis TV returned match records the provider could not parse for ` +
        `${withMatches.name} ${String(withMatches.id.year)}. Run \`npm run recon\`.`,
    ).toBe(0);

    expect(
      matches.matches.length,
      `${withMatches.name} reports a published order of play but returned no matches. ` +
        'The link between `availableOopDays` and /matches may have changed.',
    ).toBeGreaterThan(0);

    for (const match of matches.matches) {
      expect(match.id.providerMatchId).toBeTruthy();
      expect(match.schedule.onDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const unmapped = matches.matches.filter((m) => m.rawStatus.unmapped);
    expect(
      unmapped.map((m) => m.rawStatus.primary),
      'Tennis TV is serving status codes the provider does not recognise. Add them to ' +
        'src/tennistv/status-map.ts — see docs/TENNISTV_DATA_SOURCE.md §9.',
    ).toEqual([]);
  });

  it('still rejects a page size above the documented cap', async () => {
    // This is the one documented hard limit. If it moves, the paging logic can be
    // simplified; if it tightens, paging breaks.
    const response = await fetch(
      'https://api.tennistv.com/tennis/v1/tournaments?from=2026-01-01&to=2026-12-31&size=300&page=0',
      { headers: { 'account-id': '35' } },
    );

    expect(
      response.status,
      'The documented `size` cap of 250 appears to have changed; revisit MAX_PAGE_SIZE ' +
        'in src/tennistv/http-provider.ts.',
    ).toBe(400);
  });
});
