/**
 * The Tennis TV boundary.
 *
 * Everything above this line speaks domain types. Nothing above it may reference an
 * endpoint, a header, or a provider field name (ARCHITECTURE.md §15), and an
 * import-graph test enforces that.
 *
 * The interface has three methods rather than the two originally sketched, because
 * reconnaissance found the source's granularity is two-tier: tournaments are published
 * months ahead, match records only once the draw exists
 * (docs/TENNISTV_DATA_SOURCE.md §7). Fetching tournaments and fetching matches are
 * different operations with different cadences and different costs, so they are
 * different methods.
 */

import type { Match, Tournament, TournamentId } from '../domain/types.ts';

/** A tournament plus the payload it came from, kept for diagnostics. */
export interface ProviderTournament extends Tournament {
  readonly raw: unknown;
}

/** A match plus the payload it came from. */
export interface ProviderMatch extends Match {
  readonly raw: unknown;
}

/** Inclusive local-date range, `YYYY-MM-DD`. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface SnapshotMeta {
  readonly fetchedAt: Date;
  /** True when this came from cache rather than the network. */
  readonly fromCache: boolean;
  /**
   * Records the response contained that failed validation and were skipped.
   *
   * Always report this: a slowly rising skip count is how a partial schema drift
   * announces itself before it becomes an outage.
   */
  readonly skipped: number;
}

export interface TournamentSnapshot extends SnapshotMeta {
  readonly tournaments: readonly ProviderTournament[];
}

export interface MatchSnapshot extends SnapshotMeta {
  readonly matches: readonly ProviderMatch[];
}

export interface TennisTvProvider {
  /**
   * Tournaments overlapping the given local-date range.
   *
   * Callers pass the window they actually need. Loading an entire season to answer
   * "what is on this month" is both slow and impolite to the source.
   */
  getTournaments(range: DateRange): Promise<TournamentSnapshot>;

  /**
   * Every match the provider has published for one tournament.
   *
   * Returns an empty list — not an error — when the draw is not out yet. That is the
   * normal state for a tournament more than a few days away.
   */
  getTournamentMatches(id: TournamentId): Promise<MatchSnapshot>;

  /**
   * Current match state for the given tournaments, bypassing any cache.
   *
   * Used by the live monitor, where a stale answer is worse than a slow one.
   */
  getLiveState(ids: readonly TournamentId[]): Promise<MatchSnapshot>;

  /** Frees any resources held (cache timers, connections). Safe to call twice. */
  close(): void;
}
