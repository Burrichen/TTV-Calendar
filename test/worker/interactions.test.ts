import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUBSCRIPTION_ACTION_IDS } from '../../src/slack/blocks/subscription.ts';
import worker from '../../worker/index.ts';
import type { WorkerEnv } from '../../worker/config.ts';
import { SqliteD1 } from './support/d1-sqlite.ts';
import { buttonClick, encodePayload, signSlackRequest } from './support/slack-signing.ts';

/**
 * The Opt In / Opt Out buttons, driven through the Worker's real `fetch` handler.
 *
 * Deliberately end-to-end rather than calling `handleInteraction` directly: the
 * property that matters most is that an unverified request never reaches D1, and only
 * the full path can demonstrate that.
 */

const SIGNING_SECRET = 'slack-signing-secret';
const INTERNAL_SECRET = 'an-internal-secret-long-enough-to-pass';

let db: SqliteD1;

const env = (): WorkerEnv => ({
  DB: db.asD1(),
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  INTERNAL_API_SECRET: INTERNAL_SECRET,
  SLACK_CHANNEL_ID: 'C_FALLBACK',
  LOG_LEVEL: 'error',
});

const ctx = {} as ExecutionContext;

beforeEach(() => {
  db = new SqliteD1();
});

afterEach(() => {
  db.close();
});

interface ClickResult {
  readonly status: number;
  readonly body: { response_type?: string; text?: string; blocks?: unknown };
}

/**
 * Posts a properly signed button click at the Worker.
 *
 * Signed against the real clock, because the Worker verifies against the real clock —
 * its replay window is not injectable from outside, and making it so purely for tests
 * would weaken the thing being tested. `signedAt` shifts the signature into the past to
 * exercise that window.
 */
async function click(
  payload: unknown,
  options: { signedAt?: Date; secret?: string; body?: string } = {},
): Promise<ClickResult> {
  const raw = options.body ?? encodePayload(payload);
  const signed = await signSlackRequest(
    options.secret ?? SIGNING_SECRET,
    raw,
    options.signedAt ?? new Date(),
  );

  const response = await worker.fetch(
    new Request('https://worker.test/slack/interactions', {
      method: 'POST',
      headers: {
        'x-slack-signature': signed.signature,
        'x-slack-request-timestamp': signed.timestamp,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: raw,
    }),
    env(),
    ctx,
  );

  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as ClickResult['body']),
  };
}

const optIn = (userId: string, channelId?: string): Promise<ClickResult> =>
  click(
    buttonClick({
      actionId: SUBSCRIPTION_ACTION_IDS.optIn,
      userId,
      ...(channelId === undefined ? {} : { channelId }),
    }),
  );

const optOut = (userId: string, channelId?: string): Promise<ClickResult> =>
  click(
    buttonClick({
      actionId: SUBSCRIPTION_ACTION_IDS.optOut,
      userId,
      ...(channelId === undefined ? {} : { channelId }),
    }),
  );

interface SubscriptionRow {
  readonly team_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const rows = (): SubscriptionRow[] =>
  db.query<SubscriptionRow>('SELECT * FROM subscriptions ORDER BY channel_id, user_id');

describe('opting in', () => {
  it('stores the workspace, channel, user, enabled flag and timestamp', async () => {
    await optIn('U_ALICE');

    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    expect(row?.team_id).toBe('T_WORKSPACE');
    expect(row?.channel_id).toBe('C_TENNIS');
    expect(row?.user_id).toBe('U_ALICE');
    expect(row?.enabled).toBe(1);
    expect(row?.updated_at).not.toBe('');
  });

  it('confirms privately, to that user only', async () => {
    const result = await optIn('U_ALICE');

    expect(result.status).toBe(200);
    expect(result.body.response_type).toBe('ephemeral');
    expect(result.body.text).toContain('opted in');
  });

  it('is idempotent — a second click creates no second row', async () => {
    await optIn('U_ALICE');
    await optIn('U_ALICE');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.enabled).toBe(1);
  });

  it('tells a repeat clicker that nothing changed, rather than pretending it did', async () => {
    await optIn('U_ALICE');
    const second = await optIn('U_ALICE');

    expect(second.body.text).toContain('already');
  });

  it('is a set, not a toggle: clicking Opt In twice leaves you opted in', async () => {
    // A button on a summary posted weeks ago must still do what its label says.
    await optIn('U_ALICE');
    await optIn('U_ALICE');

    expect(rows()[0]?.enabled).toBe(1);
  });
});

describe('opting out', () => {
  it('disables an existing subscription', async () => {
    await optIn('U_ALICE');
    await optOut('U_ALICE');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.enabled).toBe(0);
  });

  it('confirms privately', async () => {
    await optIn('U_ALICE');
    const result = await optOut('U_ALICE');

    expect(result.body.response_type).toBe('ephemeral');
    expect(result.body.text).toContain('opted out');
  });

  it('is idempotent', async () => {
    await optIn('U_ALICE');
    await optOut('U_ALICE');
    await optOut('U_ALICE');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.enabled).toBe(0);
  });

  it('works for someone who was never opted in', async () => {
    const result = await optOut('U_STRANGER');

    expect(result.status).toBe(200);
    expect(result.body.text).toContain('already');
    expect(rows()[0]?.enabled).toBe(0);
  });

  it('lets someone opt back in afterwards', async () => {
    await optIn('U_ALICE');
    await optOut('U_ALICE');
    await optIn('U_ALICE');

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.enabled).toBe(1);
  });
});

describe('several users and several channels', () => {
  it('keeps two users independent', async () => {
    await optIn('U_ALICE');
    await optIn('U_BOB');
    await optOut('U_BOB');

    expect(rows()).toHaveLength(2);
    expect(rows().find((row) => row.user_id === 'U_ALICE')?.enabled).toBe(1);
    expect(rows().find((row) => row.user_id === 'U_BOB')?.enabled).toBe(0);
  });

  it('scopes a subscription to the channel the click came from', async () => {
    await optIn('U_ALICE', 'C_ONE');
    await optIn('U_ALICE', 'C_TWO');

    expect(rows()).toHaveLength(2);
    expect(rows().map((row) => row.channel_id)).toEqual(['C_ONE', 'C_TWO']);
  });

  it('opting out of one channel leaves the other alone', async () => {
    await optIn('U_ALICE', 'C_ONE');
    await optIn('U_ALICE', 'C_TWO');
    await optOut('U_ALICE', 'C_ONE');

    expect(rows().find((row) => row.channel_id === 'C_ONE')?.enabled).toBe(0);
    expect(rows().find((row) => row.channel_id === 'C_TWO')?.enabled).toBe(1);
  });

  it('falls back to the configured channel when the payload carries none', async () => {
    await click(
      buttonClick({ actionId: SUBSCRIPTION_ACTION_IDS.optIn, userId: 'U_ALICE', channelId: null }),
    );

    expect(rows()[0]?.channel_id).toBe('C_FALLBACK');
  });
});

describe('requests that must be refused', () => {
  it('rejects an invalid signature, and writes nothing', async () => {
    const result = await click(
      buttonClick({ actionId: SUBSCRIPTION_ACTION_IDS.optIn, userId: 'U_ATTACKER' }),
      { secret: 'the-wrong-secret' },
    );

    expect(result.status).toBe(401);
    expect(rows()).toHaveLength(0);
  });

  it('rejects a replayed request, and writes nothing', async () => {
    const signedAt = new Date(Date.now() - 60 * 60 * 1000);
    const result = await click(
      buttonClick({ actionId: SUBSCRIPTION_ACTION_IDS.optIn, userId: 'U_ATTACKER' }),
      { signedAt },
    );

    expect(result.status).toBe(401);
    expect(rows()).toHaveLength(0);
  });

  it('rejects a request with no signature headers at all', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/slack/interactions', {
        method: 'POST',
        body: encodePayload(
          buttonClick({ actionId: SUBSCRIPTION_ACTION_IDS.optIn, userId: 'U_ATTACKER' }),
        ),
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(rows()).toHaveLength(0);
  });

  it('rejects GET', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/slack/interactions'),
      env(),
      ctx,
    );

    expect(response.status).toBe(405);
  });
});

describe('payloads that are signed but malformed', () => {
  it('answers politely when the body is not a Slack payload at all', async () => {
    const result = await click(null, { body: 'this=is&not=slack' });

    expect(result.status).toBe(200);
    expect(result.body.text).toContain("couldn't read");
    expect(rows()).toHaveLength(0);
  });

  it('answers politely when the payload is not JSON', async () => {
    const result = await click(null, { body: 'payload=%7Bnot-json' });

    expect(result.status).toBe(200);
    expect(result.body.text).toContain("couldn't read");
  });

  it('acknowledges an interaction type it does not handle, without acting', async () => {
    const result = await click(
      buttonClick({
        actionId: SUBSCRIPTION_ACTION_IDS.optIn,
        userId: 'U_ALICE',
        type: 'view_submission',
      }),
    );

    expect(result.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it('ignores a button that is not one of ours', async () => {
    const result = await click(
      buttonClick({ actionId: 'some_other_app_button', userId: 'U_ALICE' }),
    );

    expect(result.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it('ignores a payload carrying no user id', async () => {
    const payload = buttonClick({ actionId: SUBSCRIPTION_ACTION_IDS.optIn, userId: 'U_ALICE' });
    const result = await click({ ...payload, user: null });

    expect(result.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it('records an unknown workspace rather than refusing the click', async () => {
    await click(
      buttonClick({ actionId: SUBSCRIPTION_ACTION_IDS.optIn, userId: 'U_ALICE', teamId: null }),
    );

    expect(rows()[0]?.team_id).toBe('unknown');
  });
});

describe('when D1 fails', () => {
  it('tells the user it failed, rather than claiming they are subscribed', async () => {
    db.failure = new Error('D1_ERROR: storage unavailable');

    const result = await optIn('U_ALICE');

    expect(result.status).toBe(200);
    expect(result.body.response_type).toBe('ephemeral');
    expect(result.body.text).toContain("couldn't update");
    expect(result.body.text).not.toContain('opted in to Tennis TV');
  });

  it('does not leak the database error to the user', async () => {
    db.failure = new Error('D1_ERROR: near "FROM": syntax error at offset 42');

    const result = await optIn('U_ALICE');

    expect(result.body.text).not.toContain('syntax error');
    expect(result.body.text).not.toContain('D1_ERROR');
  });
});

describe('other routes', () => {
  it('answers /health without authentication', async () => {
    const response = await worker.fetch(new Request('https://worker.test/health'), env(), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'ttv-calendar-worker' });
  });

  it('404s anything else', async () => {
    const response = await worker.fetch(new Request('https://worker.test/'), env(), ctx);
    expect(response.status).toBe(404);
  });

  it('reports a configuration problem without echoing the value', async () => {
    const response = await worker.fetch(
      new Request('https://worker.test/health/../slack/interactions', { method: 'POST' }),
      { ...env(), SLACK_SIGNING_SECRET: '' },
      ctx,
    );

    expect(response.status).toBe(500);
    const body = await response.json<{ detail?: string }>();
    expect(body.detail).toContain('SLACK_SIGNING_SECRET');
  });
});

describe('a missing D1 binding', () => {
  /**
   * The binding is named "DB" in wrangler.jsonc and read as `env.DB`. `wrangler d1
   * create` suggests a binding named after the database, so pasting its output wholesale
   * renames it — and every request then fails deep inside the first query with an
   * opaque 500. This turns that into a message that names the fix.
   */
  it('is reported by name rather than as an opaque failure', async () => {
    const { DB: _removed, ...withoutBinding } = env();

    const response = await worker.fetch(
      new Request('https://worker.test/slack/interactions', { method: 'POST' }),
      withoutBinding as WorkerEnv,
      ctx,
    );

    expect(response.status).toBe(500);
    const body = await response.json<{ error?: string; detail?: string }>();
    expect(body.error).toBe('configuration');
    expect(body.detail).toContain('"DB"');
    expect(body.detail).toContain('worker:deploy');
  });

  it('is caught before any request is processed', async () => {
    // Not after authentication, and not on the first query — immediately.
    const { DB: _removed, ...withoutBinding } = env();

    const response = await worker.fetch(
      new Request('https://worker.test/api/subscribers', {
        headers: { authorization: `Bearer ${INTERNAL_SECRET}` },
      }),
      withoutBinding as WorkerEnv,
      ctx,
    );

    expect(response.status).toBe(500);
  });
});
