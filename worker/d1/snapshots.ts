/**
 * Reading and writing calendar snapshots.
 *
 * Written by the GitHub Actions runner through the state API; read directly by the
 * Worker when someone opens a calendar modal. That read is the latency-critical path —
 * it happens inside Slack's three-second interaction deadline — so it is a single
 * primary-key lookup and nothing else.
 */

import type { CalendarSnapshot, SnapshotVariant } from '../../src/domain/snapshot.ts';

export interface StoredSnapshot {
  readonly periodKey: string;
  readonly variant: SnapshotVariant;
  readonly generatedAt: Date;
  readonly snapshot: CalendarSnapshot;
}

interface Row {
  readonly period_key: string;
  readonly variant: string;
  readonly period_type: string;
  readonly generated_at: string;
  readonly payload_json: string;
}

/**
 * The snapshot for one period, or null when none has been written yet.
 *
 * Returns null for unparseable JSON too. A stored payload can only be corrupt if
 * something wrote nonsense, and rendering half a calendar would be worse than saying
 * plainly that it is unavailable — which is what the caller does with null.
 */
export async function loadSnapshot(
  db: D1Database,
  periodKey: string,
  variant: SnapshotVariant,
): Promise<StoredSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT period_key, variant, period_type, generated_at, payload_json
         FROM calendar_snapshots WHERE period_key = ? AND variant = ?`,
    )
    .bind(periodKey, variant)
    .first<Row>();

  if (row === null) return null;

  let snapshot: CalendarSnapshot;
  try {
    snapshot = JSON.parse(row.payload_json) as CalendarSnapshot;
  } catch {
    return null;
  }

  return {
    periodKey: row.period_key,
    variant: variant,
    generatedAt: new Date(row.generated_at),
    snapshot,
  };
}

/** Replaces a period's snapshot wholesale. A refresh is never a partial update. */
export async function saveSnapshot(
  db: D1Database,
  snapshot: CalendarSnapshot,
  variant: SnapshotVariant,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO calendar_snapshots
         (period_key, variant, period_type, generated_at, payload_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (period_key, variant) DO UPDATE SET
         period_type  = excluded.period_type,
         generated_at = excluded.generated_at,
         payload_json = excluded.payload_json`,
    )
    .bind(
      snapshot.periodKey,
      variant,
      snapshot.periodType,
      snapshot.generatedAt,
      JSON.stringify(snapshot),
    )
    .run();
}

/**
 * Deletes snapshots older than `before`.
 *
 * Unlike match state, a stale snapshot is simply replaced on the next refresh — this
 * only clears periods that have stopped being refreshed at all, such as last month's.
 */
export async function pruneSnapshots(db: D1Database, before: Date): Promise<number> {
  const result = await db
    .prepare('DELETE FROM calendar_snapshots WHERE generated_at < ?')
    .bind(before.toISOString())
    .run();

  return result.meta.changes;
}
