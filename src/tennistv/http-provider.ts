/**
 * The production Tennis TV provider.
 *
 * The only file in the application that knows Tennis TV's endpoints, query parameters
 * and paging rules. Everything it returns is a domain object.
 *
 * Evidence for every constant here is in docs/TENNISTV_DATA_SOURCE.md §3.
 */

import type { z } from 'zod';

import type { TournamentId } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import { TtlCache } from './cache.ts';
import { TennisTvSchemaError, type SchemaIssue } from './errors.ts';
import { TennisTvHttpClient, type HttpClientOptions } from './http-client.ts';
import { mapMatch, mapTournament, type MapperOptions } from './mapper.ts';
import type {
  DateRange,
  MatchSnapshot,
  ProviderMatch,
  ProviderTournament,
  TennisTvProvider,
  TournamentSnapshot,
} from './provider.ts';
import {
  rawMatchSchema,
  rawMatchesEnvelopeSchema,
  rawTournamentListSchema,
  rawTournamentSchema,
} from './schemas.ts';

/**
 * The API rejects `size` above 250 with HTTP 400 ("size: must be less than or equal to
 * 250"), so the tournament listing is paged rather than requested in one shot.
 */
const MAX_PAGE_SIZE = 250;
/** A guard against an endless paging loop if the API ever stops shrinking pages. */
const MAX_PAGES = 20;

/**
 * When more than this share of a response fails validation, treat it as a shape change
 * rather than a few odd records.
 *
 * Skipping the occasional malformed record keeps the bot working; silently skipping
 * most of them would hide an outage behind an empty summary. A response where *every*
 * record fails is always treated as a shape change, whatever its size — otherwise a
 * one-match response that we cannot read would come back as a legitimately empty day.
 */
const MAX_SKIP_RATIO = 0.1;

export interface HttpProviderOptions {
  readonly apiBaseUrl: string;
  readonly siteBaseUrl: string;
  readonly accountId: string;
  readonly logger: Logger;
  /** Tournaments move slowly; an hour is generous and still catches same-day edits. */
  readonly tournamentTtlMs?: number;
  /** Match schedules change as order of play is published through the day. */
  readonly matchTtlMs?: number;
  readonly http?: Partial<Omit<HttpClientOptions, 'baseUrl' | 'accountId' | 'logger'>>;
  /**
   * The clock the cache ages entries against.
   *
   * Injectable so cache expiry can be tested by moving time rather than by sleeping,
   * which keeps the suite fast and free of timing flake.
   */
  readonly now?: () => number;
}

const DEFAULT_TOURNAMENT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MATCH_TTL_MS = 10 * 60 * 1000;

/**
 * The v1 path segment is part of the observed contract. It is included in every path
 * the provider builds rather than folded into the client's base URL, so the `path` in
 * a log line or an error can be appended straight to the host and re-run with curl.
 */
const API_PREFIX = '/tennis/v1';

export class HttpTennisTvProvider implements TennisTvProvider {
  readonly #client: TennisTvHttpClient;
  readonly #logger: Logger;
  readonly #mapperOptions: MapperOptions;
  readonly #tournamentCache: TtlCache<TournamentSnapshot>;
  readonly #matchCache: TtlCache<MatchSnapshot>;
  readonly #tournamentTtlMs: number;
  readonly #matchTtlMs: number;

  constructor(options: HttpProviderOptions) {
    this.#logger = options.logger.child({ component: 'tennistv-provider' });
    this.#client = new TennisTvHttpClient({
      baseUrl: options.apiBaseUrl.replace(/\/+$/, ''),
      accountId: options.accountId,
      logger: options.logger,
      ...options.http,
    });
    this.#mapperOptions = { siteBaseUrl: options.siteBaseUrl };
    this.#tournamentTtlMs = options.tournamentTtlMs ?? DEFAULT_TOURNAMENT_TTL_MS;
    this.#matchTtlMs = options.matchTtlMs ?? DEFAULT_MATCH_TTL_MS;

    const clock = options.now === undefined ? {} : { now: options.now };
    this.#tournamentCache = new TtlCache<TournamentSnapshot>(clock);
    this.#matchCache = new TtlCache<MatchSnapshot>(clock);
  }

  async getTournaments(range: DateRange): Promise<TournamentSnapshot> {
    const cacheKey = `${range.from}:${range.to}`;
    const cached = this.#tournamentCache.get(cacheKey);
    if (cached !== null) return { ...cached.value, fromCache: true };

    const tournaments: ProviderTournament[] = [];
    let skipped = 0;
    let fetchedAt = new Date();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const path =
        `${API_PREFIX}/tournaments?from=${range.from}&to=${range.to}` +
        `&size=${String(MAX_PAGE_SIZE)}&page=${String(page)}`;

      const response = await this.#client.getJson(path);
      fetchedAt = response.fetchedAt;

      const items = rawTournamentListSchema.safeParse(response.body);
      if (!items.success) {
        throw new TennisTvSchemaError({
          path,
          what: 'tournament listing',
          issues: toIssues(items.error),
          rejected: 1,
          total: 1,
          sample: response.body,
        });
      }

      const parsed = this.#parseAll(items.data, rawTournamentSchema, path, 'tournament listing');
      skipped += parsed.skipped;
      tournaments.push(...parsed.values.map((raw) => mapTournament(raw, this.#mapperOptions)));

      // A short page is the last page.
      if (items.data.length < MAX_PAGE_SIZE) break;
    }

    const snapshot: TournamentSnapshot = { tournaments, fetchedAt, fromCache: false, skipped };
    this.#tournamentCache.set(cacheKey, snapshot, this.#tournamentTtlMs);
    return snapshot;
  }

  async getTournamentMatches(id: TournamentId): Promise<MatchSnapshot> {
    const cacheKey = keyOf(id);
    const cached = this.#matchCache.get(cacheKey);
    if (cached !== null) return { ...cached.value, fromCache: true };

    const snapshot = await this.#fetchMatches(id);
    this.#matchCache.set(cacheKey, snapshot, this.#matchTtlMs);
    return snapshot;
  }

  /**
   * Live state always goes to the network.
   *
   * A cached answer here would mean announcing a match as live minutes after it
   * started, or worse, announcing one that has since been cancelled.
   */
  async getLiveState(ids: readonly TournamentId[]): Promise<MatchSnapshot> {
    if (ids.length === 0) {
      return { matches: [], fetchedAt: new Date(), fromCache: false, skipped: 0 };
    }

    const matches: ProviderMatch[] = [];
    let skipped = 0;
    let fetchedAt = new Date();

    // Sequential on purpose: a handful of tournaments at most, and concurrent bursts
    // are exactly what the access agreement asks us to avoid.
    for (const id of ids) {
      const snapshot = await this.#fetchMatches(id);
      matches.push(...snapshot.matches);
      skipped += snapshot.skipped;
      fetchedAt = snapshot.fetchedAt;

      // Keep the read-through cache warm so a summary right after a poll is free.
      this.#matchCache.set(keyOf(id), snapshot, this.#matchTtlMs);
    }

    return { matches, fetchedAt, fromCache: false, skipped };
  }

  close(): void {
    this.#tournamentCache.clear();
    this.#matchCache.clear();
  }

  async #fetchMatches(id: TournamentId): Promise<MatchSnapshot> {
    // Both parameters are required; the endpoint returns an empty envelope without them.
    const path =
      `${API_PREFIX}/matches?tournamentId=${encodeURIComponent(id.providerTournamentId)}` +
      `&year=${String(id.year)}`;
    const response = await this.#client.getJson(path);

    const envelope = rawMatchesEnvelopeSchema.safeParse(response.body);
    if (!envelope.success) {
      throw new TennisTvSchemaError({
        path,
        what: 'match envelope',
        issues: toIssues(envelope.error),
        rejected: 1,
        total: 1,
        sample: response.body,
      });
    }

    // An empty list is the normal state for a tournament whose draw is not out. It is
    // emphatically NOT evidence that matches were cancelled or removed.
    const items = envelope.data.matches ?? [];
    const parsed = this.#parseAll(items, rawMatchSchema, path, 'match records');

    // The envelope carries the tournament, which is where the venue offset and the
    // availability marker live. Without it we cannot place times on the timeline.
    const context = this.#tournamentContext(envelope.data.tournaments ?? [], id, path);

    return {
      matches: parsed.values.map((raw) => mapMatch(raw, context)),
      fetchedAt: response.fetchedAt,
      fromCache: false,
      skipped: parsed.skipped,
    };
  }

  #tournamentContext(
    rawTournaments: readonly unknown[],
    id: TournamentId,
    path: string,
  ): Parameters<typeof mapMatch>[1] {
    for (const candidate of rawTournaments) {
      const parsed = rawTournamentSchema.safeParse(candidate);
      if (!parsed.success) continue;
      if (String(parsed.data.id) !== id.providerTournamentId) continue;

      const tournament = mapTournament(parsed.data, this.#mapperOptions);
      return {
        tournamentId: tournament.id,
        tournamentName: tournament.name,
        venueUtcOffsetMinutes: tournament.venueUtcOffsetMinutes,
        tournamentIsShown: tournament.isShownOnTennisTv,
      };
    }

    // Fall back rather than fail: the matches are still usable, their times become
    // "TBC — no venue offset", and we say so loudly instead of guessing an offset.
    this.#logger.warn(
      { path, tournamentId: id.providerTournamentId, year: id.year },
      'match envelope carried no usable tournament; start times will be reported as TBC',
    );
    return {
      tournamentId: id,
      tournamentName: '',
      venueUtcOffsetMinutes: null,
      tournamentIsShown: true,
    };
  }

  /**
   * Validates each record independently.
   *
   * One malformed record must not lose a whole day's schedule, so failures are skipped
   * and counted. But if most of the response fails, the shape has changed and we throw
   * rather than reporting a near-empty schedule as though it were the truth.
   */
  #parseAll<T>(
    items: readonly unknown[],
    schema: z.ZodType<T>,
    path: string,
    what: string,
  ): { values: T[]; skipped: number } {
    const values: T[] = [];
    const issues: SchemaIssue[] = [];
    let firstRejected: unknown;

    for (const item of items) {
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        values.push(parsed.data);
        continue;
      }
      if (firstRejected === undefined) firstRejected = item;
      issues.push(...toIssues(parsed.error));
    }

    const skipped = items.length - values.length;
    if (skipped === 0) return { values, skipped: 0 };

    // Everything failed. However few records there were, that is a shape change — and
    // returning an empty schedule as though it were the truth would be worse than
    // failing, because nothing downstream could tell the difference.
    const allRejected = values.length === 0;

    if (allRejected || skipped > Math.max(1, Math.floor(items.length * MAX_SKIP_RATIO))) {
      throw new TennisTvSchemaError({
        path,
        what,
        issues: dedupeIssues(issues),
        rejected: skipped,
        total: items.length,
        sample: firstRejected,
      });
    }

    this.#logger.warn(
      { path, what, skipped, total: items.length, issues: dedupeIssues(issues).slice(0, 5) },
      'skipped records that failed validation',
    );
    return { values, skipped };
  }
}

const keyOf = (id: TournamentId): string => `${id.providerTournamentId}:${String(id.year)}`;

function toIssues(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Many records usually fail for the same reason; report each reason once. */
function dedupeIssues(issues: readonly SchemaIssue[]): SchemaIssue[] {
  const seen = new Map<string, SchemaIssue>();
  for (const issue of issues) {
    const key = `${issue.path}|${issue.message}`;
    if (!seen.has(key)) seen.set(key, issue);
  }
  return [...seen.values()];
}
