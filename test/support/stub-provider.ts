/**
 * A programmable `TennisTvProvider`.
 *
 * The fixture provider replays recorded responses, which is right for testing the
 * mapping layer. These tests are about *decisions* — did a transition alert, did an
 * empty day stay silent — so they need to state the upstream's answer directly, and
 * to be able to make it fail.
 */

import type { Match, Tournament, TournamentId } from '../../src/domain/types.ts';
import type {
  DateRange,
  MatchSnapshot,
  ProviderMatch,
  ProviderTournament,
  TennisTvProvider,
  TournamentSnapshot,
} from '../../src/tennistv/provider.ts';

export class StubTennisTvProvider implements TennisTvProvider {
  tournaments: Tournament[] = [];
  matches: Match[] = [];
  /** Live-state answer. Defaults to `matches` when not set separately. */
  liveMatches: Match[] | null = null;

  failTournaments: Error | null = null;
  failMatches: Error | null = null;
  failLiveState: Error | null = null;

  readonly requestedRanges: DateRange[] = [];
  readonly requestedTournaments: string[] = [];
  liveStateCalls = 0;
  closed = false;

  getTournaments(range: DateRange): Promise<TournamentSnapshot> {
    if (this.failTournaments) return Promise.reject(this.failTournaments);
    this.requestedRanges.push(range);

    return Promise.resolve({
      tournaments: this.tournaments.map(withRawTournament),
      fetchedAt: new Date(),
      fromCache: false,
      skipped: 0,
    });
  }

  getTournamentMatches(id: TournamentId): Promise<MatchSnapshot> {
    if (this.failMatches) return Promise.reject(this.failMatches);
    this.requestedTournaments.push(`${id.providerTournamentId}:${String(id.year)}`);

    const matches = this.matches.filter(
      (match) =>
        match.id.tournament.providerTournamentId === id.providerTournamentId &&
        match.id.tournament.year === id.year,
    );

    return Promise.resolve({
      matches: matches.map(withRaw),
      fetchedAt: new Date(),
      fromCache: false,
      skipped: 0,
    });
  }

  getLiveState(ids: readonly TournamentId[]): Promise<MatchSnapshot> {
    if (this.failLiveState) return Promise.reject(this.failLiveState);
    this.liveStateCalls += 1;

    const keys = new Set(ids.map((id) => `${id.providerTournamentId}:${String(id.year)}`));
    const source = this.liveMatches ?? this.matches;
    const matches = source.filter((match) =>
      keys.has(`${match.id.tournament.providerTournamentId}:${String(match.id.tournament.year)}`),
    );

    return Promise.resolve({
      matches: matches.map(withRaw),
      fetchedAt: new Date(),
      fromCache: false,
      skipped: 0,
    });
  }

  close(): void {
    this.closed = true;
  }
}

/** The provider types are the domain type plus the payload it came from. */
const withRaw = (value: Match): ProviderMatch => ({ ...value, raw: {} });
const withRawTournament = (value: Tournament): ProviderTournament => ({ ...value, raw: {} });
