/**
 * A provider backed by the recorded fixtures in `test/fixtures/tennistv/`.
 *
 * Runs the real schemas and the real mapper over real captured payloads, so it
 * exercises everything except the network. That makes it useful in two places: the
 * deterministic parser tests, and `TENNISTV_PROVIDER=fixture` for working on Slack
 * behaviour without touching Tennis TV.
 *
 * It is not a stub. If the mapper stops handling a real payload correctly, this
 * provider breaks in exactly the same way the live one would.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { TournamentId } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import { mapMatch, mapTournament, type MapperOptions } from './mapper.ts';
import type {
  DateRange,
  MatchSnapshot,
  ProviderMatch,
  ProviderTournament,
  TennisTvProvider,
  TournamentSnapshot,
} from './provider.ts';
import { rawMatchSchema, rawTournamentSchema } from './schemas.ts';

export interface FixtureProviderOptions {
  readonly fixtureDir: string;
  readonly siteBaseUrl: string;
  readonly logger: Logger;
}

interface LoadedFixtures {
  readonly tournaments: ProviderTournament[];
  readonly matchesByTournament: Map<string, ProviderMatch[]>;
  readonly skipped: number;
}

export class FixtureTennisTvProvider implements TennisTvProvider {
  readonly #options: FixtureProviderOptions;
  readonly #mapperOptions: MapperOptions;
  #loaded: LoadedFixtures | null = null;

  constructor(options: FixtureProviderOptions) {
    this.#options = options;
    this.#mapperOptions = { siteBaseUrl: options.siteBaseUrl };
  }

  async getTournaments(range: DateRange): Promise<TournamentSnapshot> {
    const { tournaments, skipped } = await this.#load();

    return {
      // Overlap, matching the real endpoint's behaviour rather than containment.
      tournaments: tournaments.filter(
        (tournament) => tournament.startsOn <= range.to && tournament.endsOn >= range.from,
      ),
      fetchedAt: new Date(),
      fromCache: false,
      skipped,
    };
  }

  async getTournamentMatches(id: TournamentId): Promise<MatchSnapshot> {
    const { matchesByTournament } = await this.#load();

    return {
      matches: matchesByTournament.get(keyOf(id)) ?? [],
      fetchedAt: new Date(),
      fromCache: false,
      skipped: 0,
    };
  }

  async getLiveState(ids: readonly TournamentId[]): Promise<MatchSnapshot> {
    const { matchesByTournament } = await this.#load();
    const matches = ids.flatMap((id) => matchesByTournament.get(keyOf(id)) ?? []);

    return { matches, fetchedAt: new Date(), fromCache: false, skipped: 0 };
  }

  close(): void {
    this.#loaded = null;
  }

  async #load(): Promise<LoadedFixtures> {
    if (this.#loaded !== null) return this.#loaded;

    const dir = this.#options.fixtureDir;
    const logger = this.#options.logger;
    let skipped = 0;

    const tournamentJson = JSON.parse(
      await readFile(join(dir, 'tournaments-season.json'), 'utf8'),
    ) as unknown[];

    const tournaments: ProviderTournament[] = [];
    const contexts = new Map<string, ProviderTournament>();
    for (const item of tournamentJson) {
      const parsed = rawTournamentSchema.safeParse(item);
      if (!parsed.success) {
        skipped += 1;
        logger.warn({ issues: parsed.error.issues.slice(0, 3) }, 'fixture tournament rejected');
        continue;
      }
      const tournament = mapTournament(parsed.data, this.#mapperOptions);
      tournaments.push(tournament);
      contexts.set(keyOf(tournament.id), tournament);
    }

    const matchesByTournament = new Map<string, ProviderMatch[]>();
    const files = (await readdir(dir)).filter(
      (file) => file.startsWith('matches-') && file.endsWith('.json'),
    );

    for (const file of files) {
      const key = file.replace(/^matches-|\.json$/g, '');
      const [providerTournamentId, year] = key.split('-');
      if (providerTournamentId === undefined || year === undefined) continue;

      const id: TournamentId = { providerTournamentId, year: Number(year) };
      const tournament = contexts.get(keyOf(id));

      const body = JSON.parse(await readFile(join(dir, file), 'utf8')) as {
        matches?: unknown[];
      };

      const matches: ProviderMatch[] = [];
      for (const item of body.matches ?? []) {
        const parsed = rawMatchSchema.safeParse(item);
        if (!parsed.success) {
          skipped += 1;
          logger.warn({ file, issues: parsed.error.issues.slice(0, 3) }, 'fixture match rejected');
          continue;
        }
        matches.push(
          mapMatch(parsed.data, {
            tournamentId: id,
            tournamentName: tournament?.name ?? '',
            venueUtcOffsetMinutes: tournament?.venueUtcOffsetMinutes ?? null,
            tournamentIsShown: tournament?.isShownOnTennisTv ?? true,
          }),
        );
      }

      matchesByTournament.set(keyOf(id), matches);
    }

    this.#loaded = { tournaments, matchesByTournament, skipped };
    return this.#loaded;
  }
}

const keyOf = (id: TournamentId): string => `${id.providerTournamentId}:${String(id.year)}`;
