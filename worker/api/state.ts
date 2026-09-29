/**
 * The state API.
 *
 * The Node application does all the real work — it reads Tennis TV, decides what has
 * changed, and posts to Slack — but it runs on a GitHub Actions runner that keeps
 * nothing between executions. This API lends it the Worker's D1 database for the three
 * things it genuinely cannot recompute: who is opted in, what each match looked like
 * last time, and what has already been sent.
 *
 * It is deliberately a thin, boring wrapper over the D1 repositories. No Tennis TV
 * knowledge, no Slack knowledge, no decisions — the runner decides, this remembers.
 * Keys arriving here are opaque strings; the API never parses or interprets them.
 *
 * Authorisation is a single shared secret compared in constant time. When the secret is
 * not configured the API is disabled outright rather than left open.
 */

import { z } from 'zod';

import type { Logger } from '../../src/logging/types.ts';
import type { Config } from '../config.ts';
import {
  loadMatchStates,
  pruneMatchStates,
  saveMatchStates,
  type StoredMatchState,
} from '../d1/match-state.ts';
import {
  abandonNotification,
  claimNotification,
  markFailed,
  markSent,
  markSuppressed,
  notificationStatuses,
  pruneNotifications,
} from '../d1/notifications.ts';
import { activeSubscriberIds } from '../d1/subscriptions.ts';
import { pruneSnapshots, saveSnapshot } from '../d1/snapshots.ts';
import { isMatchStatus } from '../../src/domain/types.ts';
import {
  MAX_SNAPSHOT_MATCHES,
  SNAPSHOT_PERIODS,
  SNAPSHOT_VARIANTS,
} from '../../src/domain/snapshot.ts';

const isoDate = z.iso.datetime();

const matchStateSchema = z.object({
  matchKey: z.string().min(1),
  tournamentKey: z.string().min(1),
  status: z.string().refine(isMatchStatus, { message: 'not a known MatchStatus' }),
  startsAtUtc: isoDate.nullable(),
  observedAt: isoDate,
});

const bodies = {
  loadMatchState: z.object({ keys: z.array(z.string().min(1)).max(500) }),
  saveMatchState: z.object({
    states: z.array(matchStateSchema).max(500),
    now: isoDate,
  }),
  claim: z.object({
    key: z.string().min(1),
    kind: z.enum(['ALERT', 'REPORT']),
    reference: z.string().min(1),
    now: isoDate,
  }),
  settle: z.object({
    key: z.string().min(1),
    now: isoDate,
    outcome: z.enum(['sent', 'suppressed', 'failed', 'abandoned']),
    slackTs: z.string().nullable().optional(),
    recipientCount: z.number().int().min(0).nullable().optional(),
    reason: z.string().max(500).optional(),
  }),
  statuses: z.object({ keys: z.array(z.string().min(1)).max(50) }),
  prune: z.object({ before: isoDate }),
  snapshot: z.object({
    variant: z.enum(SNAPSHOT_VARIANTS),
    snapshot: z.object({
      periodType: z.enum(SNAPSHOT_PERIODS),
      periodKey: z.string().min(1).max(64),
      from: z.string().min(1),
      to: z.string().min(1),
      timezone: z.string().min(1),
      generatedAt: isoDate,
      tournaments: z
        .array(
          z.object({
            name: z.string(),
            startsOn: z.string(),
            endsOn: z.string(),
            sourceUrl: z.string().nullable(),
            matchCount: z.number().int().min(0),
          }),
        )
        .max(200),
      matches: z
        .array(
          z.object({
            matchKey: z.string(),
            tournamentName: z.string(),
            sideOne: z.string(),
            sideTwo: z.string(),
            startsAtUtc: isoDate.nullable(),
            onDate: z.string(),
          }),
        )
        .max(MAX_SNAPSHOT_MATCHES),
    }),
  }),
} as const;

export interface StateApiOptions {
  readonly db: D1Database;
  readonly config: Config;
  readonly logger: Logger;
}

/**
 * Routes one `/api/...` request.
 *
 * Returns null when the path is not part of this API, so the caller can fall through to
 * its own 404 rather than this module guessing at the Worker's whole routing table.
 */
export async function handleStateApi(
  request: Request,
  url: URL,
  options: StateApiOptions,
): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/')) return null;

  const secret = options.config.stateApi.secret;
  if (secret === null) {
    options.logger.warn('state API called but INTERNAL_API_SECRET is not set');
    return json({ error: 'state_api_disabled' }, 404);
  }

  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(presented, secret)) {
    // No detail: an unauthorised caller learns only that it was refused.
    options.logger.warn({ path }, 'rejected state API request with an invalid token');
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    return await route(request, url, path, options);
  } catch (error) {
    // D1 unavailable, most likely. The runner must be able to tell a failure from an
    // empty answer — treating "cannot reach the database" as "nothing is claimed"
    // would let it send duplicates.
    options.logger.error({ err: error, path }, 'state API request failed');
    return json({ error: 'internal_error' }, 500);
  }
}

async function route(
  request: Request,
  url: URL,
  path: string,
  options: StateApiOptions,
): Promise<Response> {
  const { db, logger } = options;

  // --- subscriptions -------------------------------------------------------
  if (path === '/api/subscribers' && request.method === 'GET') {
    const channelId = url.searchParams.get('channel') ?? options.config.slack.channelId;
    const userIds = await activeSubscriberIds(db, channelId);
    return json({ channelId, userIds });
  }

  // --- match state ---------------------------------------------------------
  if (path === '/api/match-state/load' && request.method === 'POST') {
    const body = await parse(request, bodies.loadMatchState);
    if (body === null) return badRequest();

    const states = await loadMatchStates(db, body.keys);
    return json({
      states: [...states.values()].map((state) => ({
        matchKey: state.matchKey,
        tournamentKey: state.tournamentKey,
        status: state.status,
        startsAtUtc: state.startsAtUtc?.toISOString() ?? null,
        observedAt: state.observedAt.toISOString(),
      })),
    });
  }

  if (path === '/api/match-state/save' && request.method === 'POST') {
    const body = await parse(request, bodies.saveMatchState);
    if (body === null) return badRequest();

    const states: StoredMatchState[] = body.states.map((state) => ({
      matchKey: state.matchKey,
      tournamentKey: state.tournamentKey,
      // Re-narrowed: the schema validated it, but the parsed type is still `string`.
      status: isMatchStatus(state.status) ? state.status : 'UNKNOWN',
      startsAtUtc: state.startsAtUtc === null ? null : new Date(state.startsAtUtc),
      observedAt: new Date(state.observedAt),
    }));

    await saveMatchStates(db, states, new Date(body.now));
    return json({ saved: states.length });
  }

  // --- notifications -------------------------------------------------------
  if (path === '/api/notifications/claim' && request.method === 'POST') {
    const body = await parse(request, bodies.claim);
    if (body === null) return badRequest();

    const outcome = await claimNotification(db, {
      key: body.key,
      kind: body.kind,
      reference: body.reference,
      now: new Date(body.now),
    });

    logger.info({ key: body.key, outcome: outcome.status }, 'notification claim');
    return json(outcome);
  }

  if (path === '/api/notifications/settle' && request.method === 'POST') {
    const body = await parse(request, bodies.settle);
    if (body === null) return badRequest();

    const now = new Date(body.now);

    switch (body.outcome) {
      case 'sent':
        await markSent(db, body.key, now, {
          slackTs: body.slackTs ?? null,
          recipientCount: body.recipientCount ?? null,
        });
        break;
      case 'suppressed':
        await markSuppressed(db, body.key, body.reason ?? 'suppressed', now);
        break;
      case 'failed':
        // Stays PENDING on purpose, so a later run can re-claim it once it goes stale.
        await markFailed(db, body.key, body.reason ?? 'delivery failed');
        break;
      case 'abandoned':
        await abandonNotification(db, body.key, body.reason ?? 'abandoned', now);
        break;
    }

    logger.info({ key: body.key, outcome: body.outcome }, 'notification settled');
    return json({ key: body.key, outcome: body.outcome });
  }

  if (path === '/api/notifications/status' && request.method === 'POST') {
    const body = await parse(request, bodies.statuses);
    if (body === null) return badRequest();

    return json({ statuses: await notificationStatuses(db, body.keys) });
  }

  // --- calendar snapshots --------------------------------------------------
  if (path === '/api/snapshots/save' && request.method === 'POST') {
    const body = await parse(request, bodies.snapshot);
    if (body === null) return badRequest();

    await saveSnapshot(db, body.snapshot, body.variant);

    logger.info(
      {
        key: body.snapshot.periodKey,
        variant: body.variant,
        matches: body.snapshot.matches.length,
      },
      'calendar snapshot saved',
    );

    return json({ periodKey: body.snapshot.periodKey, variant: body.variant });
  }

  // --- retention -----------------------------------------------------------
  if (path === '/api/maintenance/prune' && request.method === 'POST') {
    const body = await parse(request, bodies.prune);
    if (body === null) return badRequest();

    const before = new Date(body.before);
    const [matches, notifications, snapshots] = await Promise.all([
      pruneMatchStates(db, before),
      pruneNotifications(db, before),
      pruneSnapshots(db, before),
    ]);

    logger.info({ matches, notifications, snapshots }, 'pruned old state');
    return json({ matches, notifications, snapshots });
  }

  return json({ error: 'not_found' }, 404);
}

/** Parses and validates a JSON body, returning null on anything malformed. */
async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const result = schema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison.
 *
 * `===` returns as soon as it finds a difference, which leaks how much of a guessed
 * token was right. Comparing every byte regardless does not.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  // Length is not secret, but returning early on it must not skip the comparison, or
  // the timing signal comes back through the other branch.
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

const badRequest = (): Response => json({ error: 'invalid_request' }, 400);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
