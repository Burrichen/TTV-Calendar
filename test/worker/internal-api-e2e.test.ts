import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateApi, StateApiError } from '../../src/state/client.ts';
import { handleStateApi } from '../../worker/api/state.ts';
import type { Config } from '../../worker/config.ts';
import { createWorkerLogger } from '../../worker/logger.ts';
import { SqliteD1 } from './support/d1-sqlite.ts';

/**
 * The GitHub Actions runner talking to the Worker, for real.
 *
 * The production client (`HttpStateApi`) is wired straight to the production handler
 * (`handleStateApi`) over a local `fetch`, backed by real SQL. Nothing between them is
 * stubbed, so a change to either side's wire format fails here — which is the one thing
 * unit tests on each half separately cannot catch.
 */

const SECRET = 'an-internal-secret-long-enough-to-pass';

let db: SqliteD1;

const config: Config = Object.freeze({
  logLevel: 'error',
  timezone: 'Europe/London',
  slack: Object.freeze({ signingSecret: 'irrelevant', botToken: null, channelId: 'C_TENNIS' }),
  stateApi: Object.freeze({ secret: SECRET }),
});

/** Routes fetch into the Worker handler instead of the network. */
const workerFetch: typeof fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const request = new Request(url, init);

  const response = await handleStateApi(request, url, {
    db: db.asD1(),
    config,
    logger: createWorkerLogger('error', {}, () => undefined),
  });

  return response ?? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
};

const client = (secret = SECRET): HttpStateApi =>
  new HttpStateApi({
    baseUrl: 'https://worker.test',
    secret,
    fetchImpl: workerFetch,
    sleep: () => Promise.resolve(),
  });

const NOW = new Date('2026-09-29T10:00:00.000Z');

beforeEach(() => {
  db = new SqliteD1();
});

afterEach(() => {
  db.close();
});

describe('authentication', () => {
  it('works with the shared secret', async () => {
    await expect(client().subscribers('C_TENNIS')).resolves.toEqual([]);
  });

  it('is refused with the wrong secret', async () => {
    await expect(client('wrong-secret-entirely').subscribers('C_TENNIS')).rejects.toBeInstanceOf(
      StateApiError,
    );
  });

  it('is refused with a secret that is a prefix of the real one', async () => {
    await expect(client(SECRET.slice(0, -1)).subscribers('C_TENNIS')).rejects.toBeInstanceOf(
      StateApiError,
    );
  });

  it('is refused with no secret at all', async () => {
    await expect(client('').subscribers('C_TENNIS')).rejects.toBeInstanceOf(StateApiError);
  });

  it('does not retry a rejected secret, since retrying cannot fix it', async () => {
    const error = await client('nope')
      .subscribers('C_TENNIS')
      .catch((caught: unknown) => caught);

    expect((error as StateApiError).status).toBe(401);
    expect((error as StateApiError).retryable).toBe(false);
  });
});

describe('subscribers', () => {
  it('round-trips what the buttons wrote', async () => {
    db.query(
      `INSERT INTO subscriptions (team_id, channel_id, user_id, enabled, created_at, updated_at)
       VALUES ('T1','C_TENNIS','U_BOB',1,?,?), ('T1','C_TENNIS','U_ALICE',1,?,?),
              ('T1','C_TENNIS','U_GONE',0,?,?)`,
      ...Array<string>(6).fill(NOW.toISOString()),
    );

    await expect(client().subscribers('C_TENNIS')).resolves.toEqual(['U_ALICE', 'U_BOB']);
  });
});

describe('match state', () => {
  it('round-trips through the real wire format, dates included', async () => {
    const api = client();

    await api.saveMatchStates(
      [
        {
          matchKey: '4713:2026:MS011',
          tournamentKey: '4713:2026',
          status: 'LIVE',
          startsAtUtc: new Date('2026-09-29T09:30:00.000Z'),
          observedAt: NOW,
        },
        {
          matchKey: '4713:2026:MS021',
          tournamentKey: '4713:2026',
          status: 'SCHEDULED',
          startsAtUtc: null,
          observedAt: NOW,
        },
      ],
      NOW,
    );

    const loaded = await api.loadMatchStates(['4713:2026:MS011', '4713:2026:MS021']);

    expect(loaded.get('4713:2026:MS011')).toEqual({
      matchKey: '4713:2026:MS011',
      tournamentKey: '4713:2026',
      status: 'LIVE',
      startsAtUtc: new Date('2026-09-29T09:30:00.000Z'),
      observedAt: NOW,
    });
    // A null start survives the round trip as null, not as an epoch date.
    expect(loaded.get('4713:2026:MS021')?.startsAtUtc).toBeNull();
  });

  it('omits matches never seen, rather than inventing them', async () => {
    const loaded = await client().loadMatchStates(['4713:2026:NEVER']);
    expect(loaded.size).toBe(0);
  });
});

describe('notification idempotency, over the wire', () => {
  const alert = {
    key: '4713:2026:MS011:LIVE',
    kind: 'ALERT' as const,
    reference: '4713:2026:MS011',
  };

  it('lets the first caller claim and refuses the second', async () => {
    const api = client();

    expect(await api.claim({ ...alert, now: NOW })).toEqual({ status: 'claimed', attempts: 1 });
    expect(await api.claim({ ...alert, now: NOW })).toMatchObject({ status: 'duplicate' });
  });

  it('refuses for good once delivery is recorded', async () => {
    const api = client();

    await api.claim({ ...alert, now: NOW });
    await api.settle({ key: alert.key, outcome: 'sent', now: NOW, slackTs: '1759.0001' });

    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await api.claim({ ...alert, now: later })).toMatchObject({
      status: 'duplicate',
      reason: 'settled',
    });
  });

  it('becomes retryable after the lease expires, so a crash does not lose the alert', async () => {
    const api = client();

    // Reserved, then the runner dies before delivering.
    await api.claim({ ...alert, now: NOW });

    const afterLease = new Date(NOW.getTime() + 11 * 60_000);
    expect(await api.claim({ ...alert, now: afterLease })).toEqual({
      status: 'claimed',
      attempts: 2,
    });
  });

  it('is not retryable while the lease is still held', async () => {
    const api = client();

    await api.claim({ ...alert, now: NOW });

    const stillHeld = new Date(NOW.getTime() + 5 * 60_000);
    expect(await api.claim({ ...alert, now: stillHeld })).toMatchObject({
      status: 'duplicate',
      reason: 'in-flight',
    });
  });

  it('treats the same match at a different status as a different event', async () => {
    const api = client();

    await api.claim({ ...alert, now: NOW });
    await api.settle({ key: alert.key, outcome: 'sent', now: NOW });

    expect(
      await api.claim({
        key: '4713:2026:MS011:CANCELLED',
        kind: 'ALERT',
        reference: '4713:2026:MS011',
        now: NOW,
      }),
    ).toEqual({ status: 'claimed', attempts: 1 });
  });
});

describe('report idempotency, over the wire', () => {
  it('reports an unknown key as outstanding', async () => {
    await expect(client().statuses(['daily:2026-09-29'])).resolves.toEqual({
      'daily:2026-09-29': null,
    });
  });

  it('reports a delivered key as SENT', async () => {
    const api = client();

    await api.claim({
      key: 'daily:2026-09-29',
      kind: 'REPORT',
      reference: '2026-09-29',
      now: NOW,
    });
    await api.settle({ key: 'daily:2026-09-29', outcome: 'sent', now: NOW });

    await expect(api.statuses(['daily:2026-09-29'])).resolves.toEqual({
      'daily:2026-09-29': 'SENT',
    });
  });

  it('answers for all three report keys in one call', async () => {
    const api = client();

    await api.claim({ key: 'weekly:2026-W40', kind: 'REPORT', reference: 'w', now: NOW });
    await api.settle({ key: 'weekly:2026-W40', outcome: 'sent', now: NOW });

    await expect(
      api.statuses(['daily:2026-09-29', 'weekly:2026-W40', 'monthly:2026-09']),
    ).resolves.toEqual({
      'daily:2026-09-29': null,
      'weekly:2026-W40': 'SENT',
      'monthly:2026-09': null,
    });
  });

  it('keeps a failed report retryable', async () => {
    const api = client();

    await api.claim({ key: 'daily:2026-09-29', kind: 'REPORT', reference: 'd', now: NOW });
    await api.settle({
      key: 'daily:2026-09-29',
      outcome: 'failed',
      now: NOW,
      reason: 'slack timeout',
    });

    await expect(api.statuses(['daily:2026-09-29'])).resolves.toEqual({
      'daily:2026-09-29': 'PENDING',
    });
  });
});

describe('the API exposes no arbitrary database access', () => {
  it('has no endpoint that takes SQL', async () => {
    for (const path of ['/api/query', '/api/sql', '/api/exec', '/api/d1']) {
      const url = new URL(`https://worker.test${path}`);
      const response = await handleStateApi(
        new Request(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ sql: 'SELECT * FROM subscriptions' }),
        }),
        url,
        { db: db.asD1(), config, logger: createWorkerLogger('error', {}, () => undefined) },
      );

      expect(response?.status).toBe(404);
    }
  });

  it('treats a key containing SQL as an ordinary string', async () => {
    const api = client();
    const nasty = "x'; DROP TABLE subscriptions; --";

    await api.claim({ key: nasty, kind: 'ALERT', reference: 'r', now: NOW });

    // The table is still there, and the key was stored verbatim by a bound parameter.
    expect(db.query('SELECT name FROM sqlite_master WHERE name = ?', 'subscriptions')).toHaveLength(
      1,
    );
    await expect(api.statuses([nasty])).resolves.toEqual({ [nasty]: 'PENDING' });
  });

  it('rejects a match status outside the known set, rather than storing it', async () => {
    const url = new URL('https://worker.test/api/match-state/save');
    const response = await handleStateApi(
      new Request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          now: NOW.toISOString(),
          states: [
            {
              matchKey: 'k',
              tournamentKey: 't',
              status: "LIVE'); DELETE FROM match_state; --",
              startsAtUtc: null,
              observedAt: NOW.toISOString(),
            },
          ],
        }),
      }),
      url,
      { db: db.asD1(), config, logger: createWorkerLogger('error', {}, () => undefined) },
    );

    expect(response?.status).toBe(400);
  });
});

describe('when D1 is unavailable', () => {
  it('surfaces an error to the runner rather than an empty answer', async () => {
    db.failure = new Error('D1_ERROR: storage unavailable');

    // "No claim exists" would make the runner post duplicates; "no subscribers" would
    // make it drop alerts. Both are worse than failing the run.
    await expect(client().subscribers('C_TENNIS')).rejects.toBeInstanceOf(StateApiError);
    await expect(
      client().claim({ key: 'k', kind: 'ALERT', reference: 'r', now: NOW }),
    ).rejects.toBeInstanceOf(StateApiError);
  });

  it('retries a 500 before giving up, since D1 blips are transient', async () => {
    let calls = 0;
    const flaky: typeof fetch = (input, init) => {
      calls += 1;
      if (calls === 1) db.failure = new Error('D1_ERROR: transient');
      else db.failure = null;
      return workerFetch(input, init);
    };

    const api = new HttpStateApi({
      baseUrl: 'https://worker.test',
      secret: SECRET,
      fetchImpl: flaky,
      sleep: () => Promise.resolve(),
    });

    await expect(api.subscribers('C_TENNIS')).resolves.toEqual([]);
    expect(calls).toBe(2);
  });
});
