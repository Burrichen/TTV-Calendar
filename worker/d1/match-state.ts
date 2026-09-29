/**
 * The Worker's memory of what each match looked like last time.
 *
 * A Cloudflare Worker keeps nothing between invocations, so without this table every
 * twenty-minute tick would rediscover each live match and alert on it again. This is
 * the `previous` half of every `detectStateChange` call.
 */

import type { MatchStatus } from '../../src/domain/types.ts';
import { isMatchStatus } from '../../src/domain/types.ts';

export interface StoredMatchState {
  readonly matchKey: string;
  readonly tournamentKey: string;
  readonly status: MatchStatus;
  readonly startsAtUtc: Date | null;
  readonly observedAt: Date;
}

interface Row {
  readonly match_key: string;
  readonly tournament_key: string;
  readonly status: string;
  readonly starts_at_utc: string | null;
  readonly observed_at: string;
}

/**
 * Loads the stored state for the given matches.
 *
 * Reads only the keys in this snapshot rather than the whole table: the query stays a
 * primary-key lookup however much history accumulates. Chunked because SQLite caps the
 * number of bound parameters in one statement.
 */
export async function loadMatchStates(
  db: D1Database,
  matchKeys: readonly string[],
): Promise<Map<string, StoredMatchState>> {
  const states = new Map<string, StoredMatchState>();
  if (matchKeys.length === 0) return states;

  for (const chunk of chunked(matchKeys, 80)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT match_key, tournament_key, status, starts_at_utc, observed_at
           FROM match_state WHERE match_key IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<Row>();

    for (const row of results) {
      // A status we no longer recognise must not be replayed as a transition; UNKNOWN
      // is inert in the state machine, which is exactly the safe reading.
      const status: MatchStatus = isMatchStatus(row.status) ? row.status : 'UNKNOWN';
      states.set(row.match_key, {
        matchKey: row.match_key,
        tournamentKey: row.tournament_key,
        status,
        startsAtUtc: row.starts_at_utc === null ? null : new Date(row.starts_at_utc),
        observedAt: new Date(row.observed_at),
      });
    }
  }

  return states;
}

/**
 * Records what we have just observed.
 *
 * Sent as one D1 batch: fewer round trips, and either the whole snapshot is recorded or
 * none of it is, so a partially-written tick cannot leave half the matches remembered
 * and half looking new.
 */
export async function saveMatchStates(
  db: D1Database,
  states: readonly StoredMatchState[],
  now: Date,
): Promise<void> {
  if (states.length === 0) return;

  const timestamp = now.toISOString();
  const statement = db.prepare(
    `INSERT INTO match_state
       (match_key, tournament_key, status, starts_at_utc, observed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_key) DO UPDATE SET
       status        = excluded.status,
       starts_at_utc = excluded.starts_at_utc,
       observed_at   = excluded.observed_at,
       updated_at    = excluded.updated_at`,
  );

  await db.batch(
    states.map((state) =>
      statement.bind(
        state.matchKey,
        state.tournamentKey,
        state.status,
        state.startsAtUtc?.toISOString() ?? null,
        state.observedAt.toISOString(),
        timestamp,
      ),
    ),
  );
}

/** Forgets matches untouched since `before`. Their tournaments are long over. */
export async function pruneMatchStates(db: D1Database, before: Date): Promise<number> {
  const result = await db
    .prepare('DELETE FROM match_state WHERE updated_at < ?')
    .bind(before.toISOString())
    .run();

  return result.meta.changes;
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
