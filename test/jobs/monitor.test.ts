import { beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config/env.ts';
import { runMonitor } from '../../src/jobs/monitor.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import { SlackPublisher } from '../../src/slack/publisher.ts';
import { TennisTvSchemaError } from '../../src/tennistv/errors.ts';
import { FakeSlackClient } from '../slack/fake-client.ts';
import { aMatch, aTournament } from '../support/builders.ts';
import { MemoryStateApi } from '../support/memory-state-api.ts';
import { StubTennisTvProvider } from '../support/stub-provider.ts';

/**
 * One monitoring run, end to end: Tennis TV → transition detection → Slack.
 *
 * The state machine itself is exhaustively tested in `domain/match-state.test.ts`. What
 * these tests cover is the run *around* it — that stored state is consulted and
 * updated, that subscribers gate delivery, that nothing is duplicated across runs, and
 * that failures land on the safe side.
 */

const CHANNEL = 'C_TENNIS';
const NOW = new Date('2026-09-29T13:05:00Z');

let provider: StubTennisTvProvider;
let state: MemoryStateApi;
let slack: FakeSlackClient;

const config = {
  timezone: 'Europe/London',
  summaryHour: 8,
  logLevel: 'silent',
  runTimeoutSeconds: 240,
  slack: { botToken: 'xoxb-test', channelId: CHANNEL, dryRun: false },
  stateApi: { baseUrl: 'https://worker.test', secret: 'x'.repeat(32) },
  tennisTv: {
    siteBaseUrl: 'https://www.tennistv.com',
    apiBaseUrl: 'https://api.tennistv.com',
    accountId: '35',
    provider: 'live',
  },
  monitor: { scheduleSlipMinutes: 15 },
  retention: { stateDays: 30 },
} as unknown as Config;

beforeEach(() => {
  provider = new StubTennisTvProvider();
  state = new MemoryStateApi();
  slack = new FakeSlackClient();
  provider.tournaments = [aTournament({ startsOn: '2026-09-28', endsOn: '2026-10-04' })];
  state.setSubscribers(CHANNEL, ['U_ALICE', 'U_BOB']);
});

const run = (now = NOW): ReturnType<typeof runMonitor> =>
  runMonitor({
    provider,
    publisher: new SlackPublisher({
      client: slack.asWebClient(),
      state,
      logger: silentLogger(),
      channelId: CHANNEL,
      dryRun: false,
    }),
    state,
    config,
    logger: silentLogger(),
    now,
  });

/** Seeds what a previous run observed. */
const seen = (matchId: string, status: string, startsAtUtc: Date | null = null): void => {
  state.matchStates.set(`4713:2026:${matchId}`, {
    matchKey: `4713:2026:${matchId}`,
    tournamentKey: '4713:2026',
    status: status as never,
    startsAtUtc,
    observedAt: new Date('2026-09-29T12:00:00Z'),
  });
};

describe('when nothing is on', () => {
  it('makes no live-state request at all', async () => {
    provider.tournaments = [];

    const result = await run();

    expect(provider.liveStateCalls).toBe(0);
    expect(slack.posts).toHaveLength(0);
    expect(result.checked).toBe(0);
  });

  it('ignores a tournament that is not running today', async () => {
    provider.tournaments = [aTournament({ startsOn: '2026-10-10', endsOn: '2026-10-17' })];

    await run();

    expect(provider.liveStateCalls).toBe(0);
  });

  it('does not ask who is subscribed when there is nothing to say', async () => {
    provider.matches = [aMatch({ status: 'SCHEDULED' })];
    seen('MS011', 'SCHEDULED');

    await run();

    expect(state.calls).not.toContain('subscribers');
  });
});

describe('transitions that alert', () => {
  it('alerts when a match goes live', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    const result = await run();

    expect(result.alerted).toBe(1);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toContain('LIVE');
  });

  it('alerts when Tennis TV explicitly reports a delay', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'DELAYED' })];

    expect((await run()).alerted).toBe(1);
    expect(slack.posts[0]?.text).toContain('DELAYED');
  });

  it('alerts when Tennis TV explicitly reports a cancellation', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'CANCELLED' })];

    expect((await run()).alerted).toBe(1);
    expect(slack.posts[0]?.text).toContain('CANCELLED');
  });

  it('alerts when a delayed match finally goes live', async () => {
    seen('MS011', 'DELAYED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    expect((await run()).alerted).toBe(1);
  });

  it('mentions every subscriber, and only subscribers', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();

    const rendered = JSON.stringify(slack.posts[0]?.blocks);
    expect(rendered).toContain('<@U_ALICE>');
    expect(rendered).toContain('<@U_BOB>');
  });

  it('never mass-mentions the channel', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();

    const rendered = JSON.stringify(slack.posts[0]);
    for (const banned of ['@channel', '@here', '@everyone']) {
      expect(rendered).not.toContain(banned);
    }
  });

  it('posts to the configured channel and never as a DM', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();

    expect(slack.posts[0]?.channel).toBe(CHANNEL);
    expect(slack.ephemerals).toHaveLength(0);
  });
});

describe('what must never be inferred', () => {
  it('does not treat a disappeared match as cancelled', async () => {
    // PROJECT_SPEC.md §6.4. The match was live; now the feed does not mention it.
    seen('MS011', 'LIVE');
    provider.matches = [];

    const result = await run();

    expect(slack.posts).toHaveLength(0);
    expect(result.transitions).toBe(0);
    // And its stored state is untouched, so it is not forgotten either.
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('LIVE');
  });

  it('does not treat an elapsed start time as a delay', async () => {
    // Scheduled for 13:00; it is now 15:00 and Tennis TV still says SCHEDULED.
    seen('MS011', 'SCHEDULED', new Date('2026-09-29T13:00:00Z'));
    provider.matches = [aMatch({ status: 'SCHEDULED' })];

    const result = await run(new Date('2026-09-29T15:00:00Z'));

    expect(slack.posts).toHaveLength(0);
    expect(result.transitions).toBe(0);
  });

  it('does treat a republished later start as a delay', async () => {
    // The distinction: Tennis TV changed its mind, rather than time passing.
    seen('MS011', 'SCHEDULED', new Date('2026-09-29T13:00:00Z'));
    provider.matches = [
      aMatch({ status: 'SCHEDULED', startsAtUtc: new Date('2026-09-29T15:00:00Z') }),
    ];

    expect((await run()).alerted).toBe(1);
    expect(slack.posts[0]?.text).toContain('DELAYED');
  });

  it('does not alert on an unrecognised status', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'UNKNOWN' })];

    expect((await run()).transitions).toBe(0);
    expect(slack.posts).toHaveLength(0);
  });

  it('does not alert merely because a match is newly seen', async () => {
    provider.matches = [aMatch({ status: 'SCHEDULED' })];

    await run();

    expect(slack.posts).toHaveLength(0);
    // But it is remembered, so the next transition is detectable.
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('SCHEDULED');
  });

  it('does alert on a first sighting that is already live', async () => {
    provider.matches = [aMatch({ status: 'LIVE' })];

    expect((await run()).alerted).toBe(1);
  });

  it('ignores a match Tennis TV does not show on its platform', async () => {
    provider.matches = [aMatch({ status: 'LIVE', isShownOnTennisTv: false })];

    await run();

    expect(slack.posts).toHaveLength(0);
  });
});

describe('repeat runs', () => {
  it('says nothing when the status has not changed', async () => {
    seen('MS011', 'LIVE');
    provider.matches = [aMatch({ status: 'LIVE' })];

    expect((await run()).transitions).toBe(0);
    expect(slack.posts).toHaveLength(0);
  });

  it('alerts once across two consecutive runs of the same transition', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();
    await run(new Date(NOW.getTime() + 30 * 60_000));

    expect(slack.posts).toHaveLength(1);
  });

  it('alerts again for a genuinely different transition on the same match', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    await run();

    provider.matches = [aMatch({ status: 'CANCELLED' })];
    await run(new Date(NOW.getTime() + 30 * 60_000));

    expect(slack.posts).toHaveLength(2);
    expect(state.sentKeys()).toEqual(['4713:2026:MS011:CANCELLED', '4713:2026:MS011:LIVE']);
  });

  it('does not duplicate when two runs overlap on the same transition', async () => {
    // The second run claims while the first still holds a fresh PENDING claim.
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await Promise.all([run(), run()]);

    expect(slack.posts).toHaveLength(1);
  });
});

describe('subscribers', () => {
  it('posts nothing when nobody is opted in, but still records the state', async () => {
    state.setSubscribers(CHANNEL, []);
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    const result = await run();

    expect(slack.posts).toHaveLength(0);
    expect(result.suppressed).toBe(1);
    // Recorded, so someone opting in later is not told about a match from an hour ago.
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('LIVE');
  });

  it('mentions only the users currently opted in', async () => {
    state.setSubscribers(CHANNEL, ['U_ALICE']);
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();

    const rendered = JSON.stringify(slack.posts[0]?.blocks);
    expect(rendered).toContain('<@U_ALICE>');
    expect(rendered).not.toContain('<@U_BOB>');
  });
});

describe('failures', () => {
  it('fails the run when Tennis TV is unreachable, rather than inventing state', async () => {
    provider.failTournaments = new Error('ECONNRESET');

    await expect(run()).rejects.toThrow('ECONNRESET');
    expect(slack.posts).toHaveLength(0);
    expect(state.matchStates.size).toBe(0);
  });

  it('keeps the old state when a Slack post fails, so the alert is retried', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    slack.failNextPost = new Error('slack unavailable');

    const failedRun = await run();

    expect(failedRun.failed).toBe(1);
    // Crucially NOT updated to LIVE — otherwise the transition would be forgotten.
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('SCHEDULED');

    // A later run, once the claim has gone stale, delivers it.
    const retry = await run(new Date(NOW.getTime() + 11 * 60_000));

    expect(retry.alerted).toBe(1);
    expect(slack.posts).toHaveLength(1);
  });

  it('fails the run when the state API is unreachable', async () => {
    // Without it there is no duplicate protection, so posting blind is worse than not
    // posting at all.
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    state.failure = new Error('worker unreachable');

    await expect(run()).rejects.toThrow('worker unreachable');
    expect(slack.posts).toHaveLength(0);
  });

  it('records the other matches when one alert fails', async () => {
    seen('MS011', 'SCHEDULED');
    seen('MS021', 'SCHEDULED');
    provider.matches = [
      aMatch({ matchId: 'MS011', status: 'LIVE' }),
      aMatch({ matchId: 'MS021', status: 'LIVE' }),
    ];
    slack.failNextPost = new Error('slack unavailable');

    const result = await run();

    expect(result.failed).toBe(1);
    // The failed one keeps its old state; the delivered one moves on.
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('SCHEDULED');
    expect(state.matchStates.get('4713:2026:MS021')?.status).toBe('LIVE');
  });
});

describe('the rest of the transition matrix', () => {
  it('alerts when a delayed match is then cancelled', async () => {
    seen('MS011', 'DELAYED');
    provider.matches = [aMatch({ status: 'CANCELLED' })];

    expect((await run()).alerted).toBe(1);
    expect(slack.posts[0]?.text).toContain('CANCELLED');
  });

  it('says nothing when a delayed match is still delayed', async () => {
    seen('MS011', 'DELAYED');
    provider.matches = [aMatch({ status: 'DELAYED' })];

    expect((await run()).transitions).toBe(0);
    expect(slack.posts).toHaveLength(0);
  });

  it('says nothing when a cancelled match is still cancelled', async () => {
    seen('MS011', 'CANCELLED');
    provider.matches = [aMatch({ status: 'CANCELLED' })];

    expect((await run()).transitions).toBe(0);
  });

  it('treats cancellation as terminal — nothing follows it', async () => {
    seen('MS011', 'CANCELLED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    expect((await run()).transitions).toBe(0);
    expect(slack.posts).toHaveLength(0);
  });

  it('treats completion as terminal too', async () => {
    seen('MS011', 'COMPLETED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    expect((await run()).transitions).toBe(0);
  });

  it('does not alert when a match simply finishes', async () => {
    seen('MS011', 'LIVE');
    provider.matches = [aMatch({ status: 'COMPLETED' })];

    expect((await run()).transitions).toBe(0);
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('COMPLETED');
  });
});

describe('subscriber edge cases', () => {
  it('does not mention a subscriber who has been disabled', async () => {
    // `activeSubscriberIds` filters on enabled, so a disabled row simply is not
    // returned; this asserts the monitor honours that rather than caching an old list.
    state.setSubscribers(CHANNEL, ['U_ALICE']);
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();

    const rendered = JSON.stringify(slack.posts[0]?.blocks);
    expect(rendered).toContain('<@U_ALICE>');
    expect(rendered).not.toContain('<@U_BOB>');
  });

  it('honours an opt-out made moments before the run', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    // Between the previous run and this one, Bob clicked Opt Out.
    state.setSubscribers(CHANNEL, ['U_ALICE']);

    await run();

    expect(JSON.stringify(slack.posts[0])).not.toContain('U_BOB');
  });

  it('reads the subscriber list fresh on every run, never from memory', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    await run();

    state.setSubscribers(CHANNEL, ['U_CAROL']);
    seen('MS021', 'SCHEDULED');
    provider.matches = [aMatch({ matchId: 'MS021', status: 'LIVE' })];
    await run();

    expect(JSON.stringify(slack.posts[1])).toContain('U_CAROL');
  });
});

describe('malformed or hostile upstream responses', () => {
  it('fails the run when the provider rejects the response shape', async () => {
    // The provider raises a schema error rather than returning partial data; the run
    // must fail loudly rather than treat "could not read" as "nothing is on".
    provider.failLiveState = new TennisTvSchemaError({
      what: 'match records',
      path: '/tennis/v1/matches?tournamentId=4713&year=2026',
      rejected: 12,
      total: 12,
      issues: [{ path: 'MatchDate', message: 'expected an ISO date-time' }],
      sample: { MatchId: 'MS011' },
    });
    provider.matches = [aMatch()];

    await expect(run()).rejects.toBeInstanceOf(TennisTvSchemaError);
    expect(slack.posts).toHaveLength(0);
  });

  it('leaves stored state untouched when the upstream cannot be read', async () => {
    seen('MS011', 'LIVE');
    provider.failLiveState = new Error('502 Bad Gateway');

    await expect(run()).rejects.toThrow();
    expect(state.matchStates.get('4713:2026:MS011')?.status).toBe('LIVE');
  });
});

describe('stateless execution', () => {
  it('carries nothing between runs except what the state API holds', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    await run();
    expect(slack.posts).toHaveLength(1);

    // A completely fresh process, with only the stored state in common.
    const revived = new MemoryStateApi();
    for (const [key, value] of state.matchStates) revived.matchStates.set(key, value);
    for (const [key, value] of state.notifications) revived.notifications.set(key, value);
    revived.setSubscribers(CHANNEL, ['U_ALICE', 'U_BOB']);

    const second = await runMonitor({
      provider,
      publisher: new SlackPublisher({
        client: slack.asWebClient(),
        state: revived,
        logger: silentLogger(),
        channelId: CHANNEL,
        dryRun: false,
      }),
      state: revived,
      config,
      logger: silentLogger(),
      now: new Date(NOW.getTime() + 30 * 60_000),
    });

    expect(second.transitions).toBe(0);
    expect(slack.posts).toHaveLength(1);
  });

  it('survives a GitHub re-run of a job that already succeeded', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];

    await run();
    // "Re-run all jobs" on a green run: same inputs, same state, hours later.
    await run(new Date(NOW.getTime() + 3 * 60 * 60 * 1000));

    expect(slack.posts).toHaveLength(1);
  });
});

describe('when Slack accepts a message but recording it fails', () => {
  it('does not send it a second time, because the channel is checked first', async () => {
    // The nastiest case: the message is in the channel, but nothing recorded that.
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    state.failOn.add('settle');

    const first = await run();

    expect(slack.posts).toHaveLength(1);
    expect(first.failed).toBe(1);

    // The claim is still PENDING. On the next run it goes stale and is re-claimed —
    // and the publisher finds its own earlier message by its metadata key.
    state.failOn.clear();
    slack.history = [
      {
        ts: '1759.0001',
        metadata: { event_payload: { idempotency_key: '4713:2026:MS011:LIVE' } },
      },
    ];

    const second = await run(new Date(NOW.getTime() + 11 * 60_000));

    expect(slack.posts).toHaveLength(1);
    expect(second.alerted).toBe(0);
    expect(state.notifications.get('4713:2026:MS011:LIVE')?.status).toBe('SENT');
  });

  it('does resend when the channel shows the message never landed', async () => {
    seen('MS011', 'SCHEDULED');
    provider.matches = [aMatch({ status: 'LIVE' })];
    slack.failNextPost = new Error('connection reset');

    await run();
    expect(slack.posts).toHaveLength(0);

    slack.history = [];
    await run(new Date(NOW.getTime() + 11 * 60_000));

    expect(slack.posts).toHaveLength(1);
  });
});
