/**
 * The "post this exactly once" ledger.
 *
 * Every user-visible message — a live alert, a daily/weekly/monthly report — is
 * claimed here before it is sent and settled here afterwards. The primary key is what
 * makes the guarantee: two Worker invocations racing on the same key cannot both win
 * the INSERT, so at most one of them posts.
 *
 * The ordering is claim → send → settle, and it is chosen deliberately. Claiming first
 * means a crash between the two leaves an unsettled claim rather than a duplicate
 * message; recovering a lost message is something a later tick can do safely, whereas
 * un-sending a duplicate is not something anyone can do at all.
 *
 * A claim left PENDING becomes re-claimable once it goes stale, so a transient Slack
 * failure is retried rather than lost. Before re-sending a retried claim the poster
 * checks the channel itself for the key — see `worker/slack/poster.ts` — which closes
 * the one window where "we never heard back" could otherwise mean "it actually landed".
 */

export type NotificationKind = 'ALERT' | 'REPORT';

export type ClaimOutcome =
  /** The claim is ours. `attempts` is 1 on the first try, higher on a retry. */
  | { readonly status: 'claimed'; readonly attempts: number }
  /** Already sent, already held by a live claim, or given up on. Post nothing. */
  | { readonly status: 'duplicate'; readonly reason: 'settled' | 'in-flight' | 'abandoned' };

/** How long a PENDING claim is respected before another invocation may take it over. */
export const CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

/** How many times a message is retried before it is abandoned rather than looping. */
export const MAX_ATTEMPTS = 5;

export interface ClaimOptions {
  readonly key: string;
  readonly kind: NotificationKind;
  readonly reference: string;
  readonly now: Date;
  readonly staleAfterMs?: number;
  readonly maxAttempts?: number;
}

/**
 * Attempts to become the sender of `key`.
 *
 * One statement does both the first claim and the stale re-claim: the INSERT wins when
 * the key is new, and the conditional upsert wins when an old PENDING claim is up for
 * grabs. Anything else — SENT, SUPPRESSED, ABANDONED, or a PENDING claim that is still
 * fresh — matches neither branch, writes nothing, and returns no row.
 */
export async function claimNotification(
  db: D1Database,
  options: ClaimOptions,
): Promise<ClaimOutcome> {
  const staleBefore = new Date(
    options.now.getTime() - (options.staleAfterMs ?? CLAIM_STALE_AFTER_MS),
  );

  const claimed = await db
    .prepare(
      `INSERT INTO notifications
         (idempotency_key, kind, reference, status, attempts, claimed_at)
       VALUES (?, ?, ?, 'PENDING', 1, ?)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         attempts   = notifications.attempts + 1,
         claimed_at = excluded.claimed_at
       WHERE notifications.status = 'PENDING' AND notifications.claimed_at < ?
       RETURNING attempts`,
    )
    .bind(
      options.key,
      options.kind,
      options.reference,
      options.now.toISOString(),
      staleBefore.toISOString(),
    )
    .first<{ attempts: number }>();

  if (claimed === null) {
    const existing = await db
      .prepare('SELECT status FROM notifications WHERE idempotency_key = ?')
      .bind(options.key)
      .first<{ status: string }>();

    if (existing?.status === 'ABANDONED') return { status: 'duplicate', reason: 'abandoned' };
    // A fresh PENDING row means another invocation is sending it right now.
    return {
      status: 'duplicate',
      reason: existing?.status === 'PENDING' ? 'in-flight' : 'settled',
    };
  }

  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  if (claimed.attempts > maxAttempts) {
    // Retried enough. Give up loudly rather than retrying every twenty minutes forever.
    await abandonNotification(
      db,
      options.key,
      `gave up after ${String(maxAttempts)} attempts`,
      options.now,
    );
    return { status: 'duplicate', reason: 'abandoned' };
  }

  return { status: 'claimed', attempts: claimed.attempts };
}

export interface SettleOptions {
  readonly slackTs?: string | null;
  readonly recipientCount?: number | null;
}

/** Records a successful delivery. The key can never be claimed again. */
export async function markSent(
  db: D1Database,
  key: string,
  now: Date,
  options: SettleOptions = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE notifications
          SET status = 'SENT', slack_ts = ?, recipient_count = ?, last_error = NULL, settled_at = ?
        WHERE idempotency_key = ?`,
    )
    .bind(options.slackTs ?? null, options.recipientCount ?? null, now.toISOString(), key)
    .run();
}

/**
 * Records that the message was deliberately not sent — a dry run, or a decision that
 * it should not go out. Terminal, like SENT: there is nothing to retry.
 */
export async function markSuppressed(
  db: D1Database,
  key: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notifications
          SET status = 'SUPPRESSED', last_error = ?, settled_at = ?
        WHERE idempotency_key = ?`,
    )
    .bind(reason, now.toISOString(), key)
    .run();
}

/**
 * Records a failed attempt, leaving the claim PENDING.
 *
 * Staying PENDING is the point: once the claim goes stale a later tick re-claims it and
 * tries again, so a Slack blip delays a notification instead of destroying it.
 */
export async function markFailed(db: D1Database, key: string, error: unknown): Promise<void> {
  await db
    .prepare(`UPDATE notifications SET last_error = ? WHERE idempotency_key = ?`)
    .bind(describe(error), key)
    .run();
}

/** Stops retrying a key for good. */
export async function abandonNotification(
  db: D1Database,
  key: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notifications
          SET status = 'ABANDONED', last_error = ?, settled_at = ?
        WHERE idempotency_key = ?`,
    )
    .bind(reason, now.toISOString(), key)
    .run();
}

/** The current status of one key, or null if it has never been claimed. */
export async function notificationStatus(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT status FROM notifications WHERE idempotency_key = ?')
    .bind(key)
    .first<{ status: string }>();

  return row?.status ?? null;
}

/**
 * The status of several keys in one round trip.
 *
 * The scheduled runner asks about all three report keys at once, and over a network
 * hop three questions cost three times as much as one.
 */
export async function notificationStatuses(
  db: D1Database,
  keys: readonly string[],
): Promise<Record<string, string | null>> {
  const statuses: Record<string, string | null> = Object.fromEntries(
    keys.map((key) => [key, null]),
  );
  if (keys.length === 0) return statuses;

  const placeholders = keys.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT idempotency_key, status FROM notifications
        WHERE idempotency_key IN (${placeholders})`,
    )
    .bind(...keys)
    .all<{ idempotency_key: string; status: string }>();

  for (const row of results) statuses[row.idempotency_key] = row.status;
  return statuses;
}

/**
 * Deletes settled notifications older than `before`.
 *
 * PENDING rows are never pruned — an unsettled claim is unfinished business, and
 * deleting one would silently re-open a duplicate window.
 */
export async function pruneNotifications(db: D1Database, before: Date): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM notifications WHERE status <> 'PENDING' AND settled_at < ?`)
    .bind(before.toISOString())
    .run();

  return result.meta.changes;
}

/** A short, safe description of a failure. Never the whole object. */
const describe = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
