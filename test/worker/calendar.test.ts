import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSnapshot } from '../../src/domain/snapshot.ts';
import { PAGE_ACTION_IDS } from '../../src/slack/blocks/calendar-views.ts';
import { NAVIGATION_ACTION_IDS } from '../../src/slack/blocks/navigation.ts';
import type { WorkerEnv } from '../../worker/config.ts';
import { saveSnapshot } from '../../worker/d1/snapshots.ts';
import worker from '../../worker/index.ts';
import { SqliteD1 } from './support/d1-sqlite.ts';
import { buttonClick, encodePayload, signSlackRequest } from './support/slack-signing.ts';

/**
 * The calendar buttons, driven through the Worker's real `fetch` handler.
 *
 * The property that matters most: **the Worker never fetches Tennis TV**. Every view
 * comes from a snapshot in D1, written earlier by the GitHub Actions runner. A missing
 * snapshot is a view that says so, not a fallback fetch.
 */

const SIGNING_SECRET = 'slack-signing-secret';
const BOT_TOKEN = 'xoxb-calendar-test';

let db: SqliteD1;
/** Every Slack API call the Worker made. */
let slackCalls: { url: string; body: Record<string, unknown> }[];
let slackOk = true;

/**
 * Bindings as Cloudflare would inject them.
 *
 * Overrides are loosely typed so a test can *remove* a binding — which is the whole
 * point of the "no bot token" case, and something `Partial<WorkerEnv>` cannot express
 * under `exactOptionalPropertyTypes`.
 */
const env = (overrides: Record<string, unknown> = {}): WorkerEnv => ({
  DB: db.asD1(),
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: BOT_TOKEN,
  INTERNAL_API_SECRET: 'an-internal-secret-long-enough-to-pass',
  SLACK_CHANNEL_ID: 'C_TENNIS',
  APP_TIMEZONE: 'Europe/London',
  LOG_LEVEL: 'error',
  ...overrides,
});

const ctx = {} as ExecutionContext;

beforeEach(() => {
  db = new SqliteD1();
  slackCalls = [];
  slackOk = true;

  // Slack is the only host the Worker talks to here. Anything else is a test bug.
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    slackCalls.push({ url, body: JSON.parse(body) as Record<string, unknown> });

    return Promise.resolve(
      new Response(
        JSON.stringify(slackOk ? { ok: true } : { ok: false, error: 'expired_trigger_id' }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** A snapshot with `days` days of play, written under `variant`. */
async function storeSnapshot(
  periodKey: string,
  periodType: 'WEEK' | 'MONTH',
  variant: 'LIVE' | 'TEST',
  days = 2,
): Promise<void> {
  // Real date arithmetic: 28 September plus four days is 2 October, not "2026-09-32".
  const start = new Date('2026-09-28T09:41:00Z');

  const matches = Array.from({ length: days }, (_, day) => {
    const startsAtUtc = new Date(start.getTime() + day * 24 * 60 * 60 * 1000);
    const onDate = startsAtUtc.toISOString().slice(0, 10);

    return {
      id: {
        tournament: { providerTournamentId: '4713', year: 2026 },
        providerMatchId: `M${String(day)}`,
      },
      tournamentName: 'Beijing',
      sideOne: { name: `Player ${String(day)}A`, isKnown: true },
      sideTwo: { name: `Player ${String(day)}B`, isKnown: true },
      schedule: {
        onDate,
        startsAtUtc,
        notBeforeUtc: null,
        tbcReason: null,
      },
      status: 'SCHEDULED' as const,
      rawStatus: { primary: 'U', secondary: null, reason: null, unmapped: false },
      round: null,
      court: null,
      isShownOnTennisTv: true,
      isSimulated: false,
    };
  });

  await saveSnapshot(
    db.asD1(),
    buildSnapshot({
      periodType,
      periodKey,
      from: '2026-09-28',
      to: '2026-10-04',
      timezone: 'Europe/London',
      generatedAt: new Date('2026-09-29T07:00:00Z'),
      tournaments: [],
      matches,
      localDateOf: (match) => match.schedule.onDate,
    }),
    variant,
  );
}

/** Posts a signed button click at the Worker. */
async function click(payload: unknown, workerEnv = env()): Promise<Response> {
  const raw = encodePayload(payload);
  const signed = await signSlackRequest(SIGNING_SECRET, raw, new Date());

  return worker.fetch(
    new Request('https://worker.test/slack/interactions', {
      method: 'POST',
      headers: {
        'x-slack-signature': signed.signature,
        'x-slack-request-timestamp': signed.timestamp,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: raw,
    }),
    workerEnv,
    ctx,
  );
}

const calendarClick = (actionId: string, value = 'LIVE'): Record<string, unknown> => ({
  ...buttonClick({ actionId, userId: 'U_ALICE' }),
  trigger_id: '123.456.trigger',
  actions: [{ action_id: actionId, type: 'button', value }],
});

const opened = (): Record<string, unknown> | undefined =>
  slackCalls.find((call) => call.url.endsWith('/views.open'))?.body;

const updated = (): Record<string, unknown> | undefined =>
  slackCalls.find((call) => call.url.endsWith('/views.update'))?.body;

const viewText = (body: Record<string, unknown> | undefined): string =>
  JSON.stringify((body as { view?: unknown } | undefined)?.view ?? {});

describe('opening a calendar', () => {
  beforeEach(async () => {
    // The Worker derives the key from the clock, so seed whatever "now" falls in.
    const now = new Date();
    const { DateTime } = await import('luxon');
    const local = DateTime.fromJSDate(now, { zone: 'Europe/London' });

    await storeSnapshot(
      `week:${String(local.weekYear)}-W${String(local.weekNumber).padStart(2, '0')}`,
      'WEEK',
      'LIVE',
    );
    await storeSnapshot(
      `month:${String(local.year)}-${String(local.month).padStart(2, '0')}`,
      'MONTH',
      'LIVE',
    );
  });

  it.each([
    ['View week', NAVIGATION_ACTION_IDS.viewWeek],
    ['Full week', NAVIGATION_ACTION_IDS.viewFullWeek],
  ])('%s opens the week modal', async (_label, actionId) => {
    const response = await click(calendarClick(actionId));

    expect(response.status).toBe(200);
    expect(viewText(opened())).toContain('Tennis TV — Week');
  });

  it.each([
    ['View month', NAVIGATION_ACTION_IDS.viewMonth],
    ['View full month', NAVIGATION_ACTION_IDS.viewFullMonth],
  ])('%s opens the month modal', async (_label, actionId) => {
    await click(calendarClick(actionId));
    expect(viewText(opened())).toContain('Tennis TV — Month');
  });

  it('passes Slack the trigger it was given', async () => {
    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));
    expect(opened()?.trigger_id).toBe('123.456.trigger');
  });

  it('posts no channel message', async () => {
    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));

    expect(slackCalls.every((call) => !call.url.includes('chat.postMessage'))).toBe(true);
  });

  it('never contacts Tennis TV', async () => {
    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));

    expect(slackCalls.every((call) => call.url.startsWith('https://slack.com/api/'))).toBe(true);
  });

  it('acknowledges within the interaction deadline even when Slack refuses', async () => {
    // An un-acknowledged interaction is retried, which would open the modal twice.
    slackOk = false;

    const response = await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));
    expect(response.status).toBe(200);
  });

  it('ignores a click with no trigger_id', async () => {
    const payload = calendarClick(NAVIGATION_ACTION_IDS.viewWeek);
    const response = await click({ ...payload, trigger_id: undefined });

    expect(response.status).toBe(200);
    expect(opened()).toBeUndefined();
  });
});

describe('security', () => {
  it('opens nothing for an invalid signature', async () => {
    const raw = encodePayload(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));
    const signed = await signSlackRequest('the-wrong-secret', raw, new Date());

    const response = await worker.fetch(
      new Request('https://worker.test/slack/interactions', {
        method: 'POST',
        headers: {
          'x-slack-signature': signed.signature,
          'x-slack-request-timestamp': signed.timestamp,
        },
        body: raw,
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(slackCalls).toHaveLength(0);
  });

  it('opens nothing for a replayed request', async () => {
    const raw = encodePayload(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));
    const signed = await signSlackRequest(
      SIGNING_SECRET,
      raw,
      new Date(Date.now() - 60 * 60 * 1000),
    );

    const response = await worker.fetch(
      new Request('https://worker.test/slack/interactions', {
        method: 'POST',
        headers: {
          'x-slack-signature': signed.signature,
          'x-slack-request-timestamp': signed.timestamp,
        },
        body: raw,
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(slackCalls).toHaveLength(0);
  });

  it('never sends the internal API secret to Slack', async () => {
    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));

    expect(JSON.stringify(slackCalls)).not.toContain('an-internal-secret-long-enough-to-pass');
  });

  it('degrades gracefully when the Worker has no bot token', async () => {
    const response = await click(
      calendarClick(NAVIGATION_ACTION_IDS.viewWeek),
      env({ SLACK_BOT_TOKEN: undefined }),
    );

    expect(response.status).toBe(200);
    expect(slackCalls).toHaveLength(0);
  });
});

describe('when no snapshot has been written', () => {
  it('explains rather than failing', async () => {
    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));

    expect(viewText(opened())).toContain('Schedule unavailable');
  });

  it('still returns 200', async () => {
    const response = await click(calendarClick(NAVIGATION_ACTION_IDS.viewMonth));
    expect(response.status).toBe(200);
  });

  it('does not fall back to fetching Tennis TV', async () => {
    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek));

    expect(slackCalls.every((call) => call.url.startsWith('https://slack.com/api/'))).toBe(true);
  });
});

describe('test snapshots are isolated', () => {
  it('a test click reads the test snapshot, not the production one', async () => {
    const { DateTime } = await import('luxon');
    const local = DateTime.fromJSDate(new Date(), { zone: 'Europe/London' });
    const key = `week:${String(local.weekYear)}-W${String(local.weekNumber).padStart(2, '0')}`;

    await storeSnapshot(key, 'WEEK', 'TEST');

    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek, 'TEST'));

    expect(viewText(opened())).toContain('Test schedule');
  });

  it('a production click does not see a test snapshot', async () => {
    const { DateTime } = await import('luxon');
    const local = DateTime.fromJSDate(new Date(), { zone: 'Europe/London' });
    const key = `week:${String(local.weekYear)}-W${String(local.weekNumber).padStart(2, '0')}`;

    // Only the test variant exists.
    await storeSnapshot(key, 'WEEK', 'TEST');

    await click(calendarClick(NAVIGATION_ACTION_IDS.viewWeek, 'LIVE'));

    expect(viewText(opened())).toContain('Schedule unavailable');
  });
});

describe('paging inside an open modal', () => {
  const pageClick = (
    actionId: string,
    metadata: unknown,
    value = '1',
  ): Record<string, unknown> => ({
    ...buttonClick({ actionId, userId: 'U_ALICE' }),
    view: { id: 'V123', private_metadata: JSON.stringify(metadata) },
    actions: [{ action_id: actionId, type: 'button', value }],
  });

  beforeEach(async () => {
    await storeSnapshot('week:2026-W40', 'WEEK', 'LIVE', 5);
  });

  it('updates the open view rather than opening another', async () => {
    await click(
      pageClick(PAGE_ACTION_IDS.next, { periodKey: 'week:2026-W40', variant: 'LIVE', page: 0 }),
    );

    expect(updated()).toBeDefined();
    expect(opened()).toBeUndefined();
  });

  it('targets the view the click came from', async () => {
    await click(
      pageClick(PAGE_ACTION_IDS.next, { periodKey: 'week:2026-W40', variant: 'LIVE', page: 0 }),
    );

    expect(updated()?.view_id).toBe('V123');
  });

  it('ignores metadata that is not valid JSON', async () => {
    const response = await click({
      ...buttonClick({ actionId: PAGE_ACTION_IDS.next, userId: 'U_ALICE' }),
      view: { id: 'V123', private_metadata: 'not json' },
      actions: [{ action_id: PAGE_ACTION_IDS.next, type: 'button', value: '1' }],
    });

    expect(response.status).toBe(200);
    expect(updated()).toBeUndefined();
  });

  it('ignores metadata whose shape is wrong', async () => {
    const response = await click(
      pageClick(PAGE_ACTION_IDS.next, { periodKey: 42, variant: 'HACKED', page: -1 }),
    );

    expect(response.status).toBe(200);
    expect(updated()).toBeUndefined();
  });

  it('ignores a page click with no open view', async () => {
    const response = await click({
      ...buttonClick({ actionId: PAGE_ACTION_IDS.previous, userId: 'U_ALICE' }),
      actions: [{ action_id: PAGE_ACTION_IDS.previous, type: 'button', value: '0' }],
    });

    expect(response.status).toBe(200);
    expect(updated()).toBeUndefined();
  });
});

describe('subscription buttons are unaffected', () => {
  it('still opt in without opening a modal', async () => {
    const response = await click(
      buttonClick({ actionId: 'ttv_subscription_opt_in', userId: 'U_ALICE' }),
    );

    expect(response.status).toBe(200);
    expect(slackCalls).toHaveLength(0);
    expect(db.query('SELECT user_id FROM subscriptions')).toHaveLength(1);
  });
});
