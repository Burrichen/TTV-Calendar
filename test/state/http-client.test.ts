import { describe, expect, it, vi } from 'vitest';

import { HttpStateApi, StateApiError } from '../../src/state/client.ts';

/**
 * The wire format, and what the client does when the Worker misbehaves.
 *
 * These tests pin the exact requests the client sends. `test/worker/state-api.test.ts`
 * pins what the Worker accepts, against real SQL; between them the two halves cannot
 * drift apart without a test going red.
 */

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** A fetch that records requests and replays queued responses. */
function stubFetch(responses: (Response | Error)[]): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;

  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    const next = responses[index++] ?? new Response('{}', { status: 200 });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });

  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const api = (responses: (Response | Error)[]): { client: HttpStateApi; calls: Recorded[] } => {
  const { fetchImpl, calls } = stubFetch(responses);
  return {
    client: new HttpStateApi({
      baseUrl: 'https://worker.test/',
      secret: 'the-secret',
      fetchImpl,
      // No real waiting between retries.
      sleep: () => Promise.resolve(),
    }),
    calls,
  };
};

const NOW = new Date('2026-09-29T10:00:00.000Z');

describe('authentication', () => {
  it('presents the secret as a bearer token', async () => {
    const { client, calls } = api([json({ userIds: [] })]);

    await client.subscribers('C1');

    expect(calls[0]?.authorization).toBe('Bearer the-secret');
  });

  it('never puts the secret in the URL', async () => {
    const { client, calls } = api([json({ userIds: [] })]);

    await client.subscribers('C1');

    expect(calls[0]?.url).not.toContain('the-secret');
  });

  it('keeps the secret out of error messages', async () => {
    const { client } = api([json({ error: 'unauthorized' }, 401)]);

    const error = await client.subscribers('C1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StateApiError);
    expect((error as StateApiError).message).not.toContain('the-secret');
  });
});

describe('request shapes', () => {
  it('asks for subscribers by channel', async () => {
    const { client, calls } = api([json({ userIds: ['U1', 'U2'] })]);

    const result = await client.subscribers('C ONE');

    expect(result).toEqual(['U1', 'U2']);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://worker.test/api/subscribers?channel=C%20ONE');
  });

  it('sends a claim with its key, kind, reference and instant', async () => {
    const { client, calls } = api([json({ status: 'claimed', attempts: 1 })]);

    const outcome = await client.claim({
      key: '4713:2026:MS011:LIVE',
      kind: 'ALERT',
      reference: '4713:2026:MS011',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'claimed', attempts: 1 });
    expect(calls[0]?.url).toBe('https://worker.test/api/notifications/claim');
    expect(calls[0]?.body).toEqual({
      key: '4713:2026:MS011:LIVE',
      kind: 'ALERT',
      reference: '4713:2026:MS011',
      now: '2026-09-29T10:00:00.000Z',
    });
  });

  it('serialises match state as ISO strings, preserving a null start', async () => {
    const { client, calls } = api([json({ saved: 1 })]);

    await client.saveMatchStates(
      [
        {
          matchKey: '4713:2026:MS011',
          tournamentKey: '4713:2026',
          status: 'SCHEDULED',
          startsAtUtc: null,
          observedAt: NOW,
        },
      ],
      NOW,
    );

    expect(calls[0]?.body).toEqual({
      now: '2026-09-29T10:00:00.000Z',
      states: [
        {
          matchKey: '4713:2026:MS011',
          tournamentKey: '4713:2026',
          status: 'SCHEDULED',
          startsAtUtc: null,
          observedAt: '2026-09-29T10:00:00.000Z',
        },
      ],
    });
  });

  it('revives dates when loading match state', async () => {
    const { client } = api([
      json({
        states: [
          {
            matchKey: '4713:2026:MS011',
            tournamentKey: '4713:2026',
            status: 'LIVE',
            startsAtUtc: '2026-09-29T09:30:00.000Z',
            observedAt: '2026-09-29T09:45:00.000Z',
          },
        ],
      }),
    ]);

    const states = await client.loadMatchStates(['4713:2026:MS011']);
    const state = states.get('4713:2026:MS011');

    expect(state?.startsAtUtc).toEqual(new Date('2026-09-29T09:30:00.000Z'));
    expect(state?.status).toBe('LIVE');
  });

  it('makes no request at all for an empty key list', async () => {
    const { client, calls } = api([]);

    await client.loadMatchStates([]);
    await client.saveMatchStates([], NOW);
    await client.statuses([]);

    expect(calls).toHaveLength(0);
  });
});

describe('retries', () => {
  it('retries a network failure and succeeds', async () => {
    const { client, calls } = api([new Error('ECONNRESET'), json({ userIds: ['U1'] })]);

    expect(await client.subscribers('C1')).toEqual(['U1']);
    expect(calls).toHaveLength(2);
  });

  it('retries a 500', async () => {
    const { client, calls } = api([json({}, 500), json({ userIds: [] })]);

    await client.subscribers('C1');

    expect(calls).toHaveLength(2);
  });

  it('gives up after the attempt limit', async () => {
    const { client, calls } = api([json({}, 500), json({}, 500), json({}, 500)]);

    await expect(client.subscribers('C1')).rejects.toBeInstanceOf(StateApiError);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 401, because the secret will not fix itself', async () => {
    const { client, calls } = api([json({ error: 'unauthorized' }, 401)]);

    await expect(client.subscribers('C1')).rejects.toBeInstanceOf(StateApiError);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 400', async () => {
    const { client, calls } = api([json({ error: 'invalid_request' }, 400)]);

    await expect(client.subscribers('C1')).rejects.toBeInstanceOf(StateApiError);
    expect(calls).toHaveLength(1);
  });
});

describe('failure is never a default answer', () => {
  it('throws rather than reporting nobody is subscribed', async () => {
    // Reading an outage as "no subscribers" would silently drop every alert.
    const { client } = api([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('boom')]);

    await expect(client.subscribers('C1')).rejects.toBeInstanceOf(StateApiError);
  });

  it('throws rather than reporting a key as unclaimed', async () => {
    // Reading an outage as "not yet sent" would post duplicates.
    const { client } = api([json({}, 503), json({}, 503), json({}, 503)]);

    await expect(
      client.claim({ key: 'k', kind: 'REPORT', reference: 'r', now: NOW }),
    ).rejects.toBeInstanceOf(StateApiError);
  });

  it('marks a 5xx retryable and a 4xx not', async () => {
    const { client } = api([json({}, 503), json({}, 503), json({}, 503)]);

    const error = await client.subscribers('C1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StateApiError);
    expect((error as StateApiError).retryable).toBe(true);
    expect((error as StateApiError).status).toBe(503);
  });
});
