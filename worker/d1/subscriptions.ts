/**
 * Who is opted in to live alerts.
 *
 * The design goal is that clicking a button twice is boring. Both operations are
 * unconditional upserts, so there is no read-modify-write on the stored state and two
 * simultaneous clicks cannot interleave into the wrong answer. The `changed` flag is
 * read first and is *only* used to word the confirmation; if it races, the worst
 * outcome is a message that says "you're opted in" instead of "you were already opted
 * in", while the stored state is correct either way.
 */

export interface SubscriberRef {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
}

export interface SubscriptionResult {
  readonly enabled: boolean;
  /** False when the user was already in this state — a repeated click. */
  readonly changed: boolean;
}

/** Sets a user's subscription to `enabled`, whatever it was before. */
export async function setSubscription(
  db: D1Database,
  ref: SubscriberRef,
  enabled: boolean,
  now: Date,
): Promise<SubscriptionResult> {
  const timestamp = now.toISOString();

  const existing = await db
    .prepare(
      'SELECT enabled FROM subscriptions WHERE team_id = ? AND channel_id = ? AND user_id = ?',
    )
    .bind(ref.teamId, ref.channelId, ref.userId)
    .first<{ enabled: number }>();

  await db
    .prepare(
      `INSERT INTO subscriptions (team_id, channel_id, user_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, channel_id, user_id)
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(ref.teamId, ref.channelId, ref.userId, enabled ? 1 : 0, timestamp, timestamp)
    .run();

  const wasEnabled = existing === null ? false : existing.enabled === 1;
  return { enabled, changed: wasEnabled !== enabled };
}

export const optIn = (db: D1Database, ref: SubscriberRef, now: Date): Promise<SubscriptionResult> =>
  setSubscription(db, ref, true, now);

export const optOut = (
  db: D1Database,
  ref: SubscriberRef,
  now: Date,
): Promise<SubscriptionResult> => setSubscription(db, ref, false, now);

/**
 * The Slack user IDs to mention in one channel.
 *
 * Sorted for a stable mention order, which keeps alerts and their tests predictable.
 * An empty result is a normal answer, and the caller's cue to post nothing at all.
 */
export async function activeSubscriberIds(
  db: D1Database,
  channelId: string,
): Promise<readonly string[]> {
  const { results } = await db
    .prepare(
      'SELECT user_id FROM subscriptions WHERE channel_id = ? AND enabled = 1 ORDER BY user_id',
    )
    .bind(channelId)
    .all<{ user_id: string }>();

  return results.map((row) => row.user_id);
}
