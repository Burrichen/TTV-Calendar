import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../../src/logging/logger.ts';
import { FixtureTennisTvProvider } from '../../src/tennistv/fixture-provider.ts';
import { isTimeTbc } from '../../src/domain/types.ts';

/**
 * Runs the real schemas and the real mapper over the real captured payloads.
 *
 * This is the test that catches a Tennis TV change in CI: re-capture with
 * `npm run recon`, and anything the provider can no longer parse or map correctly
 * fails here rather than in a Slack message.
 */

const provider = new FixtureTennisTvProvider({
  fixtureDir: join(process.cwd(), 'test', 'fixtures', 'tennistv'),
  siteBaseUrl: 'https://www.tennistv.com',
  logger: silentLogger(),
});

const SEASON = { from: '2026-01-01', to: '2026-12-31' };

describe('provider over recorded fixtures', () => {
  describe('tournaments', () => {
    it('parses and maps the whole captured season without rejecting anything', async () => {
      const snapshot = await provider.getTournaments(SEASON);

      expect(snapshot.tournaments.length).toBeGreaterThan(50);
      // A non-zero skip count means a record no longer matches our schema.
      expect(snapshot.skipped).toBe(0);
    });

    it('returns only tournaments overlapping the requested window', async () => {
      const snapshot = await provider.getTournaments({ from: '2026-09-01', to: '2026-09-30' });

      expect(snapshot.tournaments.length).toBeGreaterThan(0);
      for (const tournament of snapshot.tournaments) {
        expect(tournament.startsOn <= '2026-09-30').toBe(true);
        expect(tournament.endsOn >= '2026-09-01').toBe(true);
      }
    });

    it('excludes nothing by itself — availability is a flag, not a filter', async () => {
      // The provider reports what Tennis TV says; the domain decides what to show.
      const snapshot = await provider.getTournaments(SEASON);
      const notShown = snapshot.tournaments.filter((t) => !t.isShownOnTennisTv);

      expect(notShown.length).toBeGreaterThan(0);
      expect(notShown.map((t) => t.name).sort()).toEqual([
        'Australian Open',
        'French Open',
        'Laver Cup',
        'US Open',
        'Wimbledon',
      ]);
    });

    it('gives every not-shown tournament a reason', async () => {
      const snapshot = await provider.getTournaments(SEASON);

      for (const tournament of snapshot.tournaments) {
        if (!tournament.isShownOnTennisTv) expect(tournament.notShownReason).toBeTruthy();
        else expect(tournament.notShownReason).toBeNull();
      }
    });

    it('retains source URLs for most tournaments', async () => {
      const snapshot = await provider.getTournaments(SEASON);
      const withUrls = snapshot.tournaments.filter((t) => t.sourceUrl !== null);

      expect(withUrls.length).toBeGreaterThan(snapshot.tournaments.length / 2);
      for (const tournament of withUrls) {
        expect(tournament.sourceUrl).toMatch(/^https:\/\/www\.tennistv\.com\//);
      }
    });

    it('knows which tournaments have match data and which do not', async () => {
      const snapshot = await provider.getTournaments(SEASON);
      const byId = new Map(snapshot.tournaments.map((t) => [t.id.providerTournamentId, t]));

      // Captured 2026-09-14: Hangzhou starts in 9 days with no order of play.
      expect(byId.get('4713')?.hasPublishedMatches).toBe(false);
      // The US Open had finished, so its order of play is fully published.
      expect(byId.get('560')?.hasPublishedMatches).toBe(true);
    });
  });

  describe('matches', () => {
    it('returns an empty list for a tournament whose draw is not out', async () => {
      // Emphatically not an error, and not evidence of cancellation.
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '4713',
        year: 2026,
      });

      expect(snapshot.matches).toEqual([]);
    });

    it('parses and maps a real Grand Slam sample without rejecting anything', async () => {
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '580',
        year: 2026,
      });

      expect(snapshot.matches.length).toBeGreaterThan(0);
      expect(snapshot.skipped).toBe(0);
    });

    it('normalises every match to a known status', async () => {
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '580',
        year: 2026,
      });

      const statuses = new Set(snapshot.matches.map((m) => m.status));
      // Captured tournaments are complete, so only terminal states should appear.
      expect([...statuses].sort()).toEqual(['CANCELLED', 'COMPLETED']);
    });

    it('maps no match to UNKNOWN — every captured status is understood', async () => {
      for (const id of ['580', '520', '9900', '339']) {
        const snapshot = await provider.getTournamentMatches({
          providerTournamentId: id,
          year: 2026,
        });
        const unmapped = snapshot.matches.filter((m) => m.rawStatus.unmapped);

        expect(unmapped, `unmapped statuses in tournament ${id}`).toEqual([]);
      }
    });

    it('produces both real start times and Time TBC from the same tournament', async () => {
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '580',
        year: 2026,
      });

      const withTime = snapshot.matches.filter((m) => !isTimeTbc(m.schedule));
      const tbc = snapshot.matches.filter((m) => isTimeTbc(m.schedule));

      expect(withTime.length).toBeGreaterThan(0);
      expect(tbc.length).toBeGreaterThan(0);
      for (const match of tbc) expect(match.schedule.tbcReason).not.toBeNull();
    });

    it('gives every match a venue-local date, even when the time is unknown', async () => {
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '580',
        year: 2026,
      });

      for (const match of snapshot.matches) {
        expect(match.schedule.onDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('resolves competitors for every match', async () => {
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '520',
        year: 2026,
      });

      for (const match of snapshot.matches) {
        expect(match.sideOne.name).not.toBe('');
        expect(match.sideTwo.name).not.toBe('');
      }
    });

    it('handles the United Cup record that carries no Status field', async () => {
      const snapshot = await provider.getTournamentMatches({
        providerTournamentId: '9900',
        year: 2026,
      });

      const withoutStatus = snapshot.matches.filter((m) => m.rawStatus.primary === null);
      expect(withoutStatus.length).toBeGreaterThan(0);
      // Falls back to the representation field rather than becoming UNKNOWN.
      for (const match of withoutStatus) {
        expect(match.status).toBe('SCHEDULED');
        expect(match.rawStatus.unmapped).toBe(false);
      }
    });

    it('keeps match identity unique across tournaments', async () => {
      const ids: string[] = [];
      for (const id of ['580', '520', '9900', '339']) {
        const snapshot = await provider.getTournamentMatches({
          providerTournamentId: id,
          year: 2026,
        });
        ids.push(
          ...snapshot.matches.map(
            (m) =>
              `${m.id.tournament.providerTournamentId}:${String(m.id.tournament.year)}:${m.id.providerMatchId}`,
          ),
        );
      }

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('live state', () => {
    it('returns nothing when asked about no tournaments', async () => {
      expect((await provider.getLiveState([])).matches).toEqual([]);
    });

    it('combines matches across several tournaments', async () => {
      const snapshot = await provider.getLiveState([
        { providerTournamentId: '580', year: 2026 },
        { providerTournamentId: '520', year: 2026 },
      ]);

      const tournaments = new Set(
        snapshot.matches.map((m) => m.id.tournament.providerTournamentId),
      );
      expect(tournaments).toEqual(new Set(['580', '520']));
    });
  });
});
