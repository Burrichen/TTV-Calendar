import { afterEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../src/logging/logger.ts';
import {
  TennisTvHttpError,
  TennisTvInvalidJsonError,
  TennisTvNetworkError,
  TennisTvTimeoutError,
} from '../../src/tennistv/errors.ts';
import { TennisTvHttpClient } from '../../src/tennistv/http-client.ts';

/**
 * The retry policy decides how the bot behaves when Tennis TV is unwell, so it is
 * tested directly rather than inferred from the provider's behaviour.
 *
 * `sleep` is injected, so these run instantly and assert the delays that *would* have
 * been taken.
 */

interface StubCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** `fetch` accepts three input shapes; read the URL from whichever it is. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function stubFetch(responses: (Response | Error)[]): {
  calls: StubCall[];
  restore: () => void;
} {
  const calls: StubCall[] = [];
  let index = 0;

  const original = globalThis.fetch;
  globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: urlOf(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) return Promise.reject(new Error('stub exhausted'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
  });

  return {
    calls,
    restore: (): void => {
      globalThis.fetch = original;
    },
  };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const slept: number[] = [];

const client = (overrides: Partial<ConstructorParameters<typeof TennisTvHttpClient>[0]> = {}) =>
  new TennisTvHttpClient({
    baseUrl: 'https://api.example.test/tennis/v1',
    accountId: '35',
    logger: silentLogger(),
    baseBackoffMs: 100,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });

afterEach(() => {
  slept.length = 0;
});

describe('TennisTvHttpClient', () => {
  it('sends the account header and an identifiable user agent', async () => {
    const stub = stubFetch([json([{ id: 1 }])]);
    try {
      await client().getJson('/tournaments');

      expect(stub.calls[0]?.url).toBe('https://api.example.test/tennis/v1/tournaments');
      expect(stub.calls[0]?.headers['account-id']).toBe('35');
      expect(stub.calls[0]?.headers['user-agent']).toMatch(/TTVCalendarBot/);
    } finally {
      stub.restore();
    }
  });

  it('returns the parsed body with the attempt count', async () => {
    const stub = stubFetch([json({ matches: [] })]);
    try {
      const response = await client().getJson('/matches');

      expect(response.body).toEqual({ matches: [] });
      expect(response.attempts).toBe(1);
      expect(response.fetchedAt).toBeInstanceOf(Date);
    } finally {
      stub.restore();
    }
  });

  describe('retrying', () => {
    it('retries a 500 and succeeds', async () => {
      const stub = stubFetch([new Response('boom', { status: 500 }), json([{ id: 1 }])]);
      try {
        const response = await client().getJson('/tournaments');

        expect(response.attempts).toBe(2);
        expect(stub.calls).toHaveLength(2);
      } finally {
        stub.restore();
      }
    });

    it('retries a network failure', async () => {
      const stub = stubFetch([
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        json([]),
      ]);
      try {
        expect((await client().getJson('/tournaments')).attempts).toBe(2);
      } finally {
        stub.restore();
      }
    });

    it('gives up after the attempt budget and reports how many it made', async () => {
      const stub = stubFetch([new Response('nope', { status: 503 })]);
      try {
        await expect(client({ maxAttempts: 3 }).getJson('/tournaments')).rejects.toMatchObject({
          name: 'TennisTvHttpError',
          status: 503,
          attempts: 3,
        });
        expect(stub.calls).toHaveLength(3);
      } finally {
        stub.restore();
      }
    });

    it('does not retry a 400 — asking again will not help', async () => {
      const stub = stubFetch([
        new Response(JSON.stringify({ message: 'size: must be <= 250' }), { status: 400 }),
      ]);
      try {
        await expect(client().getJson('/tournaments?size=300')).rejects.toBeInstanceOf(
          TennisTvHttpError,
        );
        expect(stub.calls).toHaveLength(1);
      } finally {
        stub.restore();
      }
    });

    it('includes the error body, so a 400 explains itself', async () => {
      const stub = stubFetch([
        new Response(JSON.stringify({ message: 'size: must be <= 250' }), { status: 400 }),
      ]);
      try {
        await expect(client().getJson('/tournaments?size=300')).rejects.toThrow(/must be <= 250/);
      } finally {
        stub.restore();
      }
    });

    it('retries a 429', async () => {
      const stub = stubFetch([new Response('slow down', { status: 429 }), json([])]);
      try {
        expect((await client().getJson('/tournaments')).attempts).toBe(2);
      } finally {
        stub.restore();
      }
    });

    it('honours Retry-After in seconds instead of its own backoff', async () => {
      const stub = stubFetch([
        new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
        json([]),
      ]);
      try {
        await client().getJson('/tournaments');
        expect(slept).toEqual([2000]);
      } finally {
        stub.restore();
      }
    });

    it('caps a very long Retry-After', async () => {
      const stub = stubFetch([
        new Response('later', { status: 503, headers: { 'retry-after': '3600' } }),
        json([]),
      ]);
      try {
        await client({ maxBackoffMs: 8000 }).getJson('/tournaments');
        expect(slept).toEqual([8000]);
      } finally {
        stub.restore();
      }
    });

    it('backs off exponentially, with jitter, within the cap', async () => {
      const stub = stubFetch([new Response('boom', { status: 500 })]);
      try {
        await expect(
          client({ maxAttempts: 4, baseBackoffMs: 100, maxBackoffMs: 8000 }).getJson('/t'),
        ).rejects.toBeInstanceOf(TennisTvHttpError);

        // Full jitter: each delay lies in [0, ceiling] where the ceiling doubles.
        expect(slept).toHaveLength(3);
        expect(slept[0]).toBeLessThanOrEqual(100);
        expect(slept[1]).toBeLessThanOrEqual(200);
        expect(slept[2]).toBeLessThanOrEqual(400);
      } finally {
        stub.restore();
      }
    });
  });

  describe('error typing', () => {
    it('reports a timeout as a timeout', async () => {
      const stub = stubFetch([new DOMException('The operation timed out', 'TimeoutError')]);
      try {
        await expect(
          client({ maxAttempts: 1, timeoutMs: 50 }).getJson('/t'),
        ).rejects.toBeInstanceOf(TennisTvTimeoutError);
      } finally {
        stub.restore();
      }
    });

    it('reports a connection failure as a network error', async () => {
      const stub = stubFetch([new TypeError('fetch failed')]);
      try {
        await expect(client({ maxAttempts: 1 }).getJson('/t')).rejects.toBeInstanceOf(
          TennisTvNetworkError,
        );
      } finally {
        stub.restore();
      }
    });

    it('reports unparseable JSON distinctly from a network problem', async () => {
      const stub = stubFetch([
        new Response('<html>maintenance</html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ]);
      try {
        await expect(client({ maxAttempts: 1 }).getJson('/t')).rejects.toBeInstanceOf(
          TennisTvInvalidJsonError,
        );
      } finally {
        stub.restore();
      }
    });

    it('marks transient failures retryable and client errors not', () => {
      expect(new TennisTvHttpError(500, { path: '/t' }).retryable).toBe(true);
      expect(new TennisTvHttpError(429, { path: '/t' }).retryable).toBe(true);
      expect(new TennisTvHttpError(404, { path: '/t' }).retryable).toBe(false);
      expect(new TennisTvHttpError(400, { path: '/t' }).retryable).toBe(false);
    });

    it('never puts the request body of a failure in the message unbounded', async () => {
      const stub = stubFetch([new Response('x'.repeat(5000), { status: 400 })]);
      try {
        await expect(client().getJson('/t')).rejects.toThrow(/…/);
      } finally {
        stub.restore();
      }
    });
  });
});
