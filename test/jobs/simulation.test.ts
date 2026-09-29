import { beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config/env.ts';
import { isSimulationKind, runSimulation, SIMULATION_KINDS } from '../../src/jobs/simulation.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import { TEST_MARKER } from '../../src/slack/blocks/simulation.ts';
import { SlackPublisher } from '../../src/slack/publisher.ts';
import { FakeSlackClient } from '../slack/fake-client.ts';
import { aMatch, aTournament } from '../support/builders.ts';
import { MemoryStateApi } from '../support/memory-state-api.ts';
import { StubTennisTvProvider } from '../support/stub-provider.ts';

/**
 * Simulation mode.
 *
 * The point of a simulation is that it uses the production path, so these tests are
 * mostly about what it must NOT do: consume a real idempotency key, write match state,
 * or post anything that could be mistaken for a real alert.
 */

const CHANNEL = 'C_TENNIS';
const NOW = new Date('2026-09-29T13:05:00Z');

let provider: StubTennisTvProvider;
let state: MemoryStateApi;
let slack: FakeSlackClient;

const config = {
  timezone: 'Europe/London',
  summaryHour: 8,
  slack: { botToken: 'xoxb-test', channelId: CHANNEL, dryRun: false },
  stateApi: { baseUrl: 'https://worker.test', secret: 'x'.repeat(32) },
  monitor: { scheduleSlipMinutes: 15 },
  retention: { stateDays: 30 },
} as unknown as Config;

beforeEach(() => {
  provider = new StubTennisTvProvider();
  state = new MemoryStateApi();
  slack = new FakeSlackClient();
  state.setSubscribers(CHANNEL, ['U_ALICE', 'U_BOB']);
  provider.tournaments = [aTournament({ startsOn: '2026-09-28', endsOn: '2026-10-04' })];
  provider.matches = [aMatch({ onDate: '2026-09-29' })];
});

const simulate = (
  kind: (typeof SIMULATION_KINDS)[number],
  now = NOW,
): ReturnType<typeof runSimulation> =>
  runSimulation(kind, {
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

describe('every simulation kind', () => {
  it.each(SIMULATION_KINDS)('%s posts something marked as a test', async (kind) => {
    const result = await simulate(kind);

    expect(result.posted).toBe(true);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toContain(TEST_MARKER);
  });

  it.each(SIMULATION_KINDS)('%s marks the message body, not just the fallback', async (kind) => {
    await simulate(kind);

    expect(JSON.stringify(slack.posts[0]?.blocks)).toContain(TEST_MARKER);
  });

  it('is recognised by name, and nothing else is', () => {
    for (const kind of SIMULATION_KINDS) expect(isSimulationKind(kind)).toBe(true);
    for (const wrong of ['', 'LIVE', 'everything', 'drop table']) {
      expect(isSimulationKind(wrong)).toBe(false);
    }
  });
});

describe('what a simulation must never do', () => {
  it.each(SIMULATION_KINDS)('%s never writes match state', async (kind) => {
    await simulate(kind);

    // A fabricated match must never become the "previous state" a real run compares
    // against — that would suppress or invent a genuine alert later.
    expect(state.matchStates.size).toBe(0);
  });

  it.each(['live', 'delayed', 'cancelled'] as const)(
    '%s never consumes a real alert key',
    async (kind) => {
      await simulate(kind);

      for (const key of state.notifications.keys()) expect(key.startsWith('sim:')).toBe(true);
    },
  );

  it.each(['daily', 'weekly', 'monthly'] as const)(
    '%s never consumes a real report key',
    async (kind) => {
      await simulate(kind);

      expect(state.notifications.has(`daily:2026-09-29`)).toBe(false);
      expect(state.notifications.has(`weekly:2026-W40`)).toBe(false);
      expect(state.notifications.has(`monthly:2026-09`)).toBe(false);
    },
  );

  it('leaves the real report still sendable afterwards', async () => {
    await simulate('weekly');

    // The morning run must be entirely unaffected by the drill.
    expect(state.notifications.has('weekly:2026-W40')).toBe(false);
  });

  it('can be run twice without being suppressed as a duplicate', async () => {
    await simulate('live');
    await simulate('live', new Date(NOW.getTime() + 1000));

    expect(slack.posts).toHaveLength(2);
  });

  it('never mass-mentions the channel', async () => {
    await simulate('live');

    const rendered = JSON.stringify(slack.posts[0]);
    for (const banned of ['@channel', '@here', '@everyone']) {
      expect(rendered).not.toContain(banned);
    }
  });

  it('posts to the configured channel, never as a DM', async () => {
    await simulate('live');

    expect(slack.posts[0]?.channel).toBe(CHANNEL);
    expect(slack.ephemerals).toHaveLength(0);
  });
});

describe('simulation uses the real subscriber lookup', () => {
  it('mentions exactly the people who are opted in', async () => {
    state.setSubscribers(CHANNEL, ['U_CAROL']);

    await simulate('live');

    const rendered = JSON.stringify(slack.posts[0]?.blocks);
    expect(rendered).toContain('<@U_CAROL>');
    expect(rendered).not.toContain('<@U_ALICE>');
  });

  it('posts nothing when nobody is opted in, and says why', async () => {
    // This is what makes "did my opt-in work?" answerable.
    state.setSubscribers(CHANNEL, []);

    const result = await simulate('live');

    expect(result.posted).toBe(false);
    expect(slack.posts).toHaveLength(0);
    expect(result.detail).toContain('Nobody is opted in');
    expect(result.detail).toContain('Opt in');
  });
});

describe('the report simulations', () => {
  it('render regardless of whether the report is due right now', async () => {
    // 13:05 on a Tuesday: neither the weekly nor the monthly would normally be due.
    const result = await simulate('monthly');

    expect(result.posted).toBe(true);
    expect(slack.posts[0]?.text).toContain('September');
  });

  it('render even when the real report has already been sent today', async () => {
    state.markSent('daily:2026-09-29', NOW);

    const result = await simulate('daily');

    expect(result.posted).toBe(true);
  });

  it('explains plainly when there is genuinely nothing to show', async () => {
    provider.tournaments = [];
    provider.matches = [];

    const result = await simulate('daily');

    expect(result.posted).toBe(false);
    expect(result.detail).toContain('no Tennis TV matches today');
  });
});

describe('dry run', () => {
  const dryRunSimulate = (
    kind: (typeof SIMULATION_KINDS)[number],
  ): ReturnType<typeof runSimulation> =>
    runSimulation(kind, {
      provider,
      publisher: new SlackPublisher({
        client: slack.asWebClient(),
        state,
        logger: silentLogger(),
        channelId: CHANNEL,
        dryRun: true,
      }),
      state,
      config: { ...config, slack: { ...config.slack, dryRun: true } },
      logger: silentLogger(),
      now: NOW,
    });

  it('sends nothing to Slack', async () => {
    await dryRunSimulate('live');

    expect(slack.posts).toHaveLength(0);
  });

  it('reports a dry run as a dry run, not as a failure', async () => {
    const result = await dryRunSimulate('live');

    expect(result.detail).toContain('Dry run');
    expect(result.detail).not.toContain('could not');
  });
});
