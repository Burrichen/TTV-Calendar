import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleStateApi } from '../../worker/api/state.ts';
import type { Config } from '../../worker/config.ts';
import { createWorkerLogger } from '../../worker/logger.ts';
import { SqliteD1 } from './support/d1-sqlite.ts';

/**
 * The state API, exercised end-to-end against real SQL.
 *
 * These run the actual migration and the actual statements through `node:sqlite`, which
 * is what D1 is. That matters more here than anywhere else in the suite: the entire
 * duplicate-prevention design is a conditional upsert with `RETURNING`, and a hand-
 * written fake would only be testing the fake.
 */

const SECRET = 'a-test-secret-long-enough-to-pass-validation';

let db: SqliteD1;

const config: Config = Object.freeze({
  logLevel: 'error',
  timezone: 'Europe/London',
  slack: Object.freeze({ signingSecret: 'irrelevant', botToken: null, channelId: 'C_DEFAULT' }),
  stateApi: Object.freeze({ secret: SECRET }),
});

beforeEach(() => {
  db = new SqliteD1();
});

afterEach(() => {
  db.close();
});

/** Calls the API the way the Worker's router would. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { secret?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = options.secret === undefined ? SECRET : options.secret;
  const url = new URL(`https://worker.test${path}`);

  const request = new Request(url, {
    method,
    headers: {
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const response = await handleStateApi(request, url, {
    db: db.asD1(),
    config,
    logger: createWorkerLogger('error', {}, () => undefined),
  });

  if (response === null) throw new Error(`no route matched ${path}`);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const now = new Date('2026-09-29T10:00:00Z');
const iso = now.toISOString();

describe('authorisation', () => {
  it('rejects a request with no token', async () => {
    const result = await call('GET', '/api/subscribers', undefined, { secret: null });
    expect(result.status).toBe(401);
  });

  it('rejects a request with the wrong token', async () => {
    const result = await call('GET', '/api/subscribers', undefined, { secret: 'wrong' });
    expect(result.status).toBe(401);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const result = await call('GET', '/api/subscribers', undefined, {
      secret: SECRET.slice(0, -1),
    });
    expect(result.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    const result = await call('GET', '/api/subscribers');
    expect(result.status).toBe(200);
  });

  it('disables the API entirely when no secret is configured', async () => {
    const url = new URL('https://worker.test/api/subscribers');
    const response = await handleStateApi(new Request(url), url, {
      db: db.asD1(),
      config: { ...config, stateApi: { secret: null } },
      logger: createWorkerLogger('error', {}, () => undefined),
    });

    // 404, not 401: an unconfigured endpoint should not even admit to existing.
    expect(response?.status).toBe(404);
  });

  it('ignores paths that are not part of the API', async () => {
    const url = new URL('https://worker.test/slack/interactions');
    const response = await handleStateApi(new Request(url), url, {
      db: db.asD1(),
      config,
      logger: createWorkerLogger('error', {}, () => undefined),
    });

    expect(response).toBeNull();
  });
});

describe('subscribers', () => {
  const insert = (userId: string, enabled: number, channel = 'C_MAIN'): void => {
    db.query(
      `INSERT INTO subscriptions (team_id, channel_id, user_id, enabled, created_at, updated_at)
       VALUES ('T1', ?, ?, ?, ?, ?)`,
      channel,
      userId,
      enabled,
      iso,
      iso,
    );
  };

  it('returns nobody when there are no subscriptions', async () => {
    const result = await call('GET', '/api/subscribers?channel=C_MAIN');
    expect(result.body.userIds).toEqual([]);
  });

  it('returns only enabled subscribers, sorted', async () => {
    insert('U_BETA', 1);
    insert('U_ALPHA', 1);
    insert('U_GONE', 0);

    const result = await call('GET', '/api/subscribers?channel=C_MAIN');
    expect(result.body.userIds).toEqual(['U_ALPHA', 'U_BETA']);
  });

  it('scopes subscribers to their channel', async () => {
    insert('U_HERE', 1, 'C_MAIN');
    insert('U_ELSEWHERE', 1, 'C_OTHER');

    const result = await call('GET', '/api/subscribers?channel=C_MAIN');
    expect(result.body.userIds).toEqual(['U_HERE']);
  });
});

describe('notification claims', () => {
  const claim = (
    key: string,
    at = iso,
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    call('POST', '/api/notifications/claim', {
      key,
      kind: 'ALERT',
      reference: 'ref',
      now: at,
    });

  it('grants the first claim', async () => {
    const result = await claim('k1');
    expect(result.body).toMatchObject({ status: 'claimed', attempts: 1 });
  });

  it('refuses a second claim while the first is still in flight', async () => {
    await claim('k1');
    const second = await claim('k1');

    expect(second.body).toMatchObject({ status: 'duplicate', reason: 'in-flight' });
  });

  it('refuses every later claim once the key is settled', async () => {
    await claim('k1');
    await call('POST', '/api/notifications/settle', { key: 'k1', outcome: 'sent', now: iso });

    const again = await claim('k1');
    expect(again.body).toMatchObject({ status: 'duplicate', reason: 'settled' });
  });

  it('lets a later run take over a stale pending claim, so a failure is retried', async () => {
    await claim('k1');

    // Eleven minutes later: past the ten-minute staleness threshold.
    const later = new Date(now.getTime() + 11 * 60_000).toISOString();
    const retry = await claim('k1', later);

    expect(retry.body).toMatchObject({ status: 'claimed', attempts: 2 });
  });

  it('abandons a key rather than retrying it forever', async () => {
    let at = now.getTime();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await claim('k1', new Date(at).toISOString());
      expect(result.body.status).toBe('claimed');
      at += 11 * 60_000;
    }

    const sixth = await claim('k1', new Date(at).toISOString());
    expect(sixth.body).toMatchObject({ status: 'duplicate', reason: 'abandoned' });

    const stored = db.query<{ status: string }>(
      'SELECT status FROM notifications WHERE idempotency_key = ?',
      'k1',
    );
    expect(stored[0]?.status).toBe('ABANDONED');
  });

  it('keeps a failed claim pending, so it is not lost', async () => {
    await claim('k1');
    await call('POST', '/api/notifications/settle', {
      key: 'k1',
      outcome: 'failed',
      now: iso,
      reason: 'slack timeout',
    });

    const stored = db.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM notifications WHERE idempotency_key = ?',
      'k1',
    );
    expect(stored[0]?.status).toBe('PENDING');
    expect(stored[0]?.last_error).toBe('slack timeout');
  });

  it('records a suppressed decision as terminal', async () => {
    await claim('k1');
    await call('POST', '/api/notifications/settle', {
      key: 'k1',
      outcome: 'suppressed',
      now: iso,
      reason: 'no matches scheduled',
    });

    expect((await claim('k1')).body).toMatchObject({ status: 'duplicate' });
  });
});

describe('notification statuses', () => {
  it('reports null for keys never claimed, so a report is treated as outstanding', async () => {
    const result = await call('POST', '/api/notifications/status', {
      keys: ['daily:2026-09-29', 'weekly:2026-W40'],
    });

    expect(result.body.statuses).toEqual({
      'daily:2026-09-29': null,
      'weekly:2026-W40': null,
    });
  });

  it('reports the stored status for keys that exist', async () => {
    await call('POST', '/api/notifications/claim', {
      key: 'daily:2026-09-29',
      kind: 'REPORT',
      reference: '2026-09-29',
      now: iso,
    });
    await call('POST', '/api/notifications/settle', {
      key: 'daily:2026-09-29',
      outcome: 'sent',
      now: iso,
    });

    const result = await call('POST', '/api/notifications/status', {
      keys: ['daily:2026-09-29', 'monthly:2026-09'],
    });

    expect(result.body.statuses).toEqual({
      'daily:2026-09-29': 'SENT',
      'monthly:2026-09': null,
    });
  });
});

describe('match state', () => {
  const state = (matchKey: string, status: string, startsAtUtc: string | null = null): object => ({
    matchKey,
    tournamentKey: '4713:2026',
    status,
    startsAtUtc,
    observedAt: iso,
  });

  it('returns nothing for matches never seen', async () => {
    const result = await call('POST', '/api/match-state/load', { keys: ['4713:2026:MS011'] });
    expect(result.body.states).toEqual([]);
  });

  it('round-trips a saved state', async () => {
    await call('POST', '/api/match-state/save', {
      now: iso,
      states: [state('4713:2026:MS011', 'LIVE', '2026-09-29T09:30:00.000Z')],
    });

    const result = await call('POST', '/api/match-state/load', { keys: ['4713:2026:MS011'] });

    expect(result.body.states).toEqual([
      {
        matchKey: '4713:2026:MS011',
        tournamentKey: '4713:2026',
        status: 'LIVE',
        startsAtUtc: '2026-09-29T09:30:00.000Z',
        observedAt: iso,
      },
    ]);
  });

  it('overwrites on a second save rather than accumulating rows', async () => {
    await call('POST', '/api/match-state/save', {
      now: iso,
      states: [state('4713:2026:MS011', 'SCHEDULED')],
    });
    await call('POST', '/api/match-state/save', {
      now: iso,
      states: [state('4713:2026:MS011', 'LIVE')],
    });

    const rows = db.query('SELECT * FROM match_state');
    expect(rows).toHaveLength(1);

    const result = await call('POST', '/api/match-state/load', { keys: ['4713:2026:MS011'] });
    expect((result.body.states as { status: string }[])[0]?.status).toBe('LIVE');
  });

  it('preserves a null start time, which means Tennis TV published none', async () => {
    await call('POST', '/api/match-state/save', {
      now: iso,
      states: [state('4713:2026:MS011', 'SCHEDULED', null)],
    });

    const result = await call('POST', '/api/match-state/load', { keys: ['4713:2026:MS011'] });
    expect((result.body.states as { startsAtUtc: null }[])[0]?.startsAtUtc).toBeNull();
  });

  it('rejects a status that is not a known MatchStatus', async () => {
    const result = await call('POST', '/api/match-state/save', {
      now: iso,
      states: [state('4713:2026:MS011', 'WAT')],
    });

    expect(result.status).toBe(400);
    expect(db.query('SELECT * FROM match_state')).toHaveLength(0);
  });
});

describe('malformed requests', () => {
  it.each([
    ['/api/notifications/claim', { key: '', kind: 'ALERT', reference: 'r', now: iso }],
    ['/api/notifications/claim', { key: 'k', kind: 'BOGUS', reference: 'r', now: iso }],
    ['/api/notifications/settle', { key: 'k', outcome: 'exploded', now: iso }],
    ['/api/match-state/save', { now: 'not-a-date', states: [] }],
    ['/api/maintenance/prune', { before: 'yesterday' }],
  ])('rejects %s with an invalid body', async (path, body) => {
    const result = await call('POST', path, body);
    expect(result.status).toBe(400);
  });

  it('rejects a body that is not JSON at all', async () => {
    const url = new URL('https://worker.test/api/notifications/status');
    const response = await handleStateApi(
      new Request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: 'not json',
      }),
      url,
      { db: db.asD1(), config, logger: createWorkerLogger('error', {}, () => undefined) },
    );

    expect(response?.status).toBe(400);
  });

  it('404s an unknown endpoint under /api/', async () => {
    const result = await call('GET', '/api/nope');
    expect(result.status).toBe(404);
  });
});

describe('when D1 is unavailable', () => {
  it('reports a server error rather than an empty answer', async () => {
    // The distinction matters: a runner that reads "no claim exists" from a database
    // outage would post duplicates.
    db.failure = new Error('D1_ERROR: storage unavailable');

    const result = await call('POST', '/api/notifications/claim', {
      key: 'k1',
      kind: 'ALERT',
      reference: 'r',
      now: iso,
    });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'internal_error' });
  });

  it('does not report an empty subscriber list', async () => {
    db.failure = new Error('D1_ERROR: storage unavailable');

    const result = await call('GET', '/api/subscribers?channel=C_MAIN');
    expect(result.status).toBe(500);
  });
});

describe('retention', () => {
  it('deletes settled notifications and old match state, but never a pending claim', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z').toISOString();

    db.query(
      `INSERT INTO notifications (idempotency_key, kind, reference, status, claimed_at, settled_at)
       VALUES ('settled', 'ALERT', 'r', 'SENT', ?, ?), ('pending', 'ALERT', 'r', 'PENDING', ?, NULL)`,
      old,
      old,
      old,
    );
    db.query(
      `INSERT INTO match_state (match_key, tournament_key, status, starts_at_utc, observed_at, updated_at)
       VALUES ('old', 't', 'COMPLETED', NULL, ?, ?)`,
      old,
      old,
    );

    const result = await call('POST', '/api/maintenance/prune', { before: iso });

    expect(result.body).toEqual({ matches: 1, notifications: 1, snapshots: 0 });
    expect(db.query('SELECT idempotency_key FROM notifications')).toEqual([
      { idempotency_key: 'pending' },
    ]);
  });
});
