import { beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config/env.ts';
import { runMorning } from '../../src/jobs/morning.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import { SlackPublisher } from '../../src/slack/publisher.ts';
import { FakeSlackClient } from '../slack/fake-client.ts';
import { occurrenceFor } from '../../src/schedule/occurrences.ts';
import { reportKey } from '../../src/schedule/report-keys.ts';
import type { SummaryKind } from '../../src/domain/types.ts';
import { aMatch, aTournament } from '../support/builders.ts';
import { MemoryStateApi } from '../support/memory-state-api.ts';
import { StubTennisTvProvider } from '../support/stub-provider.ts';

/**
 * The morning run.
 *
 * The workflow fires at 07:00 and 08:00 UTC and lets this decide which is 08:00 in
 * London. So the important cases here are not "does a report render" — that is
 * `slack/summaries.test.ts` — but *when* a run posts, how often, and what happens on
 * the run that fires at the wrong hour.
 *
 * Calendar facts these tests rely on, all verified against the IANA database:
 *   2026-06-01  Monday AND the 1st, in BST  → 08:00 London = 07:00 UTC
 *   2026-02-02  Monday, in GMT              → 08:00 London = 08:00 UTC
 *   2026-09-29  an ordinary Tuesday, in BST
 */

const CHANNEL = 'C_TENNIS';

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
});

const run = (now: string): ReturnType<typeof runMorning> =>
  runMorning({
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
    now: new Date(now),
  });

/** Puts one tournament with one match on the given local date. */
const scheduleOn = (date: string): void => {
  provider.tournaments = [aTournament({ startsOn: date, endsOn: date })];
  provider.matches = [aMatch({ onDate: date, startsAtUtc: new Date(`${date}T13:00:00Z`) })];
};

const postedHeadings = (): string[] => slack.posts.map((post) => post.text);

/**
 * Marks the given reports as already delivered for the period containing `now`.
 *
 * With an empty history every catchable occurrence is outstanding — that is the
 * catch-up mechanism, not a bug — so a test about the daily report has to say that this
 * week's and this month's have already gone out. Otherwise it is really testing three
 * reports at once.
 */
const alreadySent = (now: string, kinds: readonly SummaryKind[]): void => {
  for (const kind of kinds) {
    const occurrence = occurrenceFor(kind, new Date(now), {
      timezone: 'Europe/London',
      hour: 8,
    });
    state.markSent(reportKey(occurrence, 'Europe/London'), new Date(now));
  }
};

const EXCEPT_DAILY = ['WEEKLY', 'MONTHLY'] as const;

describe('deciding whether a report is due', () => {
  it('posts nothing at 07:00 UTC in winter, because that is only 07:00 in London', async () => {
    scheduleOn('2026-02-02');
    alreadySent('2026-02-02T07:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-02-02T07:00:00Z');

    expect(slack.posts).toHaveLength(0);
    // 08:00 local has not arrived, so today's daily is not yet due.
    expect(result.due).not.toContain('DAILY');
  });

  it('posts at 08:00 UTC in winter, which is 08:00 in London', async () => {
    scheduleOn('2026-02-02');

    await run('2026-02-02T08:00:00Z');

    expect(slack.posts.length).toBeGreaterThan(0);
  });

  it('posts at 07:00 UTC in summer, which is 08:00 in London', async () => {
    scheduleOn('2026-06-01');

    await run('2026-06-01T07:00:00Z');

    expect(slack.posts.length).toBeGreaterThan(0);
  });

  it('does not post twice when the second cron fires an hour later in summer', async () => {
    scheduleOn('2026-06-01');

    await run('2026-06-01T07:00:00Z');
    const posts = slack.posts.length;
    await run('2026-06-01T08:00:00Z');

    expect(slack.posts).toHaveLength(posts);
  });

  it('still posts on the later run if the earlier one never happened', async () => {
    // A missed runner, a queue backlog, a failed deploy. The report is not lost.
    scheduleOn('2026-06-01');

    await run('2026-06-01T08:00:00Z');

    expect(slack.posts.length).toBeGreaterThan(0);
  });

  it('catches up later the same day, because the report is still current', async () => {
    scheduleOn('2026-09-29');

    await run('2026-09-29T14:00:00Z');

    expect(postedHeadings().join(' ')).toContain('today');
  });
});

describe('daily', () => {
  it('posts when there are matches today', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-09-29T07:00:00Z');

    expect(result.posted).toBe(1);
    expect(postedHeadings()[0]).toContain('today');
  });

  it('posts NOTHING when today has no matches', async () => {
    provider.tournaments = [];
    provider.matches = [];
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-09-29T07:00:00Z');

    expect(slack.posts).toHaveLength(0);
    expect(result.posted).toBe(0);
  });

  it('records the empty decision, so later runs do not re-check all morning', async () => {
    provider.tournaments = [];
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-09-29T07:00:00Z');

    expect(state.notifications.get('daily:2026-09-29')?.status).toBe('SUPPRESSED');
  });

  it('does not post a daily report for a tournament with no matches today', async () => {
    // The tournament is on, but the order of play is not published yet.
    provider.tournaments = [
      aTournament({ startsOn: '2026-09-29', endsOn: '2026-10-04', hasPublishedMatches: false }),
    ];
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-09-29T07:00:00Z');

    expect(slack.posts).toHaveLength(0);
  });
});

describe('weekly', () => {
  it('posts on a Monday, in addition to the daily', async () => {
    scheduleOn('2026-06-01');

    const result = await run('2026-06-01T07:00:00Z');

    expect(result.due).toContain('WEEKLY');
    expect(postedHeadings().join(' ')).toContain('weekly schedule');
  });

  it('posts even when the week has no matches at all', async () => {
    // Silence is indistinguishable from a broken bot (PROJECT_SPEC.md §4.2).
    provider.tournaments = [];

    await run('2026-02-02T08:00:00Z');

    expect(postedHeadings().join(' ')).toContain('weekly schedule');
  });

  it('does not repost on a Tuesday once Monday has sent it', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', ['WEEKLY', 'MONTHLY']);

    await run('2026-09-29T07:00:00Z');

    expect(postedHeadings().join(' ')).not.toContain('weekly schedule');
  });

  it('catches up on a Tuesday when Monday never sent it', async () => {
    // The week is still current, so the report is still worth having
    // (docs/ARCHITECTURE.md §7.2). Only the following week is too late.
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', ['MONTHLY']);

    await run('2026-09-29T07:00:00Z');

    expect(postedHeadings().join(' ')).toContain('weekly schedule');
  });

  it('uses an ISO week key, so it is claimed once per week', async () => {
    provider.tournaments = [];

    await run('2026-02-02T08:00:00Z');

    expect(state.notifications.has('weekly:2026-W06')).toBe(true);
  });
});

describe('monthly', () => {
  it('posts on the first of the month', async () => {
    scheduleOn('2026-06-01');

    const result = await run('2026-06-01T07:00:00Z');

    expect(result.due).toContain('MONTHLY');
    expect(postedHeadings().join(' ')).toContain('June');
  });

  it('posts even when the month has nothing scheduled', async () => {
    provider.tournaments = [];

    await run('2026-01-01T08:00:00Z');

    expect(postedHeadings().join(' ')).toContain('January');
  });

  it('shows TBC rather than inventing a time when none is published', async () => {
    provider.tournaments = [aTournament({ startsOn: '2026-06-01', endsOn: '2026-06-07' })];
    provider.matches = [aMatch({ onDate: '2026-06-03', startsAtUtc: null })];

    await run('2026-06-01T07:00:00Z');

    const rendered = JSON.stringify(slack.posts);
    expect(rendered).toContain('TBC');
  });

  it('uses a month key', async () => {
    provider.tournaments = [];

    await run('2026-01-01T08:00:00Z');

    expect(state.notifications.has('monthly:2026-01')).toBe(true);
  });
});

describe('a Monday that is also the first of the month', () => {
  it('posts all three reports', async () => {
    scheduleOn('2026-06-01');

    const result = await run('2026-06-01T07:00:00Z');

    expect(result.due).toEqual(['DAILY', 'WEEKLY', 'MONTHLY']);
    expect(result.posted).toBe(3);
  });

  it('omits only the daily when that day has no matches', async () => {
    // Weekly and monthly are independent requirements and still post.
    provider.tournaments = [aTournament({ startsOn: '2026-06-10', endsOn: '2026-06-12' })];
    provider.matches = [aMatch({ onDate: '2026-06-10' })];

    const result = await run('2026-06-01T07:00:00Z');

    expect(result.posted).toBe(2);
    expect(postedHeadings().join(' ')).not.toContain('today');
  });

  it('reads Tennis TV once rather than once per report', async () => {
    scheduleOn('2026-06-01');

    await run('2026-06-01T07:00:00Z');

    expect(provider.requestedRanges).toHaveLength(1);
  });

  it('claims three independent keys', async () => {
    scheduleOn('2026-06-01');

    await run('2026-06-01T07:00:00Z');

    expect(state.sentKeys()).toEqual(['daily:2026-06-01', 'monthly:2026-06', 'weekly:2026-W23']);
  });
});

describe('repeat runs', () => {
  it('does not repost anything on a second run the same morning', async () => {
    scheduleOn('2026-06-01');

    await run('2026-06-01T07:00:00Z');
    await run('2026-06-01T07:20:00Z');

    expect(slack.posts).toHaveLength(3);
  });

  it('asks Tennis TV nothing at all once everything is sent', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);
    await run('2026-09-29T07:00:00Z');
    const reads = provider.requestedRanges.length;

    await run('2026-09-29T09:00:00Z');

    expect(provider.requestedRanges).toHaveLength(reads);
  });
});

describe('failures', () => {
  it('fails the run when Tennis TV is unreachable, and claims nothing', async () => {
    provider.failTournaments = new Error('ETIMEDOUT');

    await expect(run('2026-09-29T07:00:00Z')).rejects.toThrow('ETIMEDOUT');
    expect(state.notifications.size).toBe(0);
  });

  it('leaves the claim retryable when Slack fails', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);
    slack.failNextPost = new Error('slack unavailable');

    const result = await run('2026-09-29T07:00:00Z');

    expect(result.failed).toBe(1);
    expect(state.notifications.get('daily:2026-09-29')?.status).toBe('PENDING');
  });

  it('delivers on a later run after a Slack failure', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);
    slack.failNextPost = new Error('slack unavailable');
    await run('2026-09-29T07:00:00Z');

    // Past the claim staleness threshold.
    const result = await run('2026-09-29T07:15:00Z');

    expect(result.posted).toBe(1);
    expect(slack.posts).toHaveLength(1);
  });

  it('still sends the other reports when one fails', async () => {
    scheduleOn('2026-06-01');
    slack.failNextPost = new Error('slack unavailable');

    const result = await run('2026-06-01T07:00:00Z');

    expect(result.failed).toBe(1);
    expect(result.posted).toBe(2);
  });

  it('fails the run when the state API is unreachable', async () => {
    scheduleOn('2026-09-29');
    state.failure = new Error('worker unreachable');

    await expect(run('2026-09-29T07:00:00Z')).rejects.toThrow('worker unreachable');
    expect(slack.posts).toHaveLength(0);
  });
});

describe('daylight saving transitions', () => {
  /**
   * The two days a hard-coded offset would get wrong. Both are resolved by Luxon
   * against the IANA database — nothing in this project computes an offset.
   *
   *   2026-03-29  clocks go FORWARD  → 08:00 London is 07:00 UTC
   *   2026-10-25  clocks go BACK     → 08:00 London is 08:00 UTC
   */

  it('posts at 07:00 UTC on the spring-forward day', async () => {
    scheduleOn('2026-03-29');
    alreadySent('2026-03-29T07:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-03-29T07:00:00Z');

    expect(result.posted).toBe(1);
  });

  it('does not post again at 08:00 UTC on the spring-forward day', async () => {
    scheduleOn('2026-03-29');
    alreadySent('2026-03-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-03-29T07:00:00Z');
    const posts = slack.posts.length;
    await run('2026-03-29T08:00:00Z');

    expect(slack.posts).toHaveLength(posts);
  });

  it('does NOT post at 07:00 UTC on the autumn fall-back day, because that is 07:00 local', async () => {
    scheduleOn('2026-10-25');
    alreadySent('2026-10-25T07:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-10-25T07:00:00Z');

    expect(result.due).not.toContain('DAILY');
    expect(slack.posts).toHaveLength(0);
  });

  it('posts at 08:00 UTC on the autumn fall-back day', async () => {
    scheduleOn('2026-10-25');
    alreadySent('2026-10-25T08:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-10-25T08:00:00Z');

    expect(result.posted).toBe(1);
  });

  it('files a match under the UK date the reader will see, across the change', async () => {
    // The report must not list a match under a day it does not display.
    provider.tournaments = [aTournament({ startsOn: '2026-10-25', endsOn: '2026-10-25' })];
    provider.matches = [
      aMatch({ onDate: '2026-10-25', startsAtUtc: new Date('2026-10-25T14:00:00Z') }),
    ];
    alreadySent('2026-10-25T08:00:00Z', EXCEPT_DAILY);

    await run('2026-10-25T08:00:00Z');

    expect(slack.posts).toHaveLength(1);
  });
});

describe('times that are not yet settled', () => {
  it('shows TBC rather than guessing when no start time is published', async () => {
    provider.tournaments = [aTournament({ startsOn: '2026-09-29', endsOn: '2026-09-29' })];
    provider.matches = [aMatch({ onDate: '2026-09-29', startsAtUtc: null })];
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-09-29T07:00:00Z');

    expect(JSON.stringify(slack.posts)).toContain('TBC');
  });

  it('shows the new time when a match has been rescheduled', async () => {
    // Tennis TV republished the match two hours later; the report simply renders what
    // is published now. No memory of the old time is involved.
    provider.tournaments = [aTournament({ startsOn: '2026-09-29', endsOn: '2026-09-29' })];
    provider.matches = [
      aMatch({ onDate: '2026-09-29', startsAtUtc: new Date('2026-09-29T16:30:00Z') }),
    ];
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-09-29T07:00:00Z');

    // 16:30 UTC is 17:30 in London in September.
    expect(JSON.stringify(slack.posts)).toContain('17:30');
  });

  it('lists a TBC match alongside one with a known time', async () => {
    provider.tournaments = [aTournament({ startsOn: '2026-09-29', endsOn: '2026-09-29' })];
    provider.matches = [
      aMatch({ matchId: 'MS011', onDate: '2026-09-29' }),
      aMatch({ matchId: 'MS021', onDate: '2026-09-29', startsAtUtc: null }),
    ];
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-09-29T07:00:00Z');

    const rendered = JSON.stringify(slack.posts);
    expect(rendered).toContain('TBC');
    expect(rendered).toContain('14:00');
  });
});

describe('when GitHub starts the job late', () => {
  it('still posts the daily report an hour late', async () => {
    // GitHub's scheduler queues under load; a run can start well after its cron minute.
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    const result = await run('2026-09-29T09:47:00Z');

    expect(result.posted).toBe(1);
  });

  it('still posts the weekly report on Tuesday if Monday never ran at all', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', ['MONTHLY']);

    await run('2026-09-29T07:00:00Z');

    expect(postedHeadings().join(' ')).toContain('weekly schedule');
  });

  it('gives up on last week rather than sending it during this one', async () => {
    // Beyond the grace window the report is no longer current, and a stale schedule is
    // worse than none (docs/ARCHITECTURE.md §7.2).
    provider.tournaments = [];

    const result = await run('2026-10-06T07:00:00Z');

    // The occurrence now in scope is THIS week's, not the one that was missed.
    expect(state.notifications.has('weekly:2026-W40')).toBe(false);
    expect(result.due).toContain('WEEKLY');
  });
});

describe('retention', () => {
  it('sweeps old state on the run that does the morning work', async () => {
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);

    await run('2026-09-29T07:00:00Z');

    expect(state.calls).toContain('prune');
  });

  it('does not sweep on a run with nothing to do', async () => {
    // The 48 monitor runs and the second morning cron must not pay for housekeeping.
    alreadySent('2026-09-29T07:00:00Z', ['DAILY', 'WEEKLY', 'MONTHLY']);

    await run('2026-09-29T07:00:00Z');

    expect(state.calls).not.toContain('prune');
  });

  it('does not sweep during a simulation', async () => {
    scheduleOn('2026-09-29');

    await runMorning({
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
      now: new Date('2026-09-29T07:00:00Z'),
      simulated: true,
      force: [
        occurrenceFor('DAILY', new Date('2026-09-29T07:00:00Z'), {
          timezone: 'Europe/London',
          hour: 8,
        }),
      ],
    });

    expect(state.calls).not.toContain('prune');
  });

  it('still reports success when the sweep fails', async () => {
    // Housekeeping must never turn a delivered report into a failed run.
    scheduleOn('2026-09-29');
    alreadySent('2026-09-29T07:00:00Z', EXCEPT_DAILY);
    state.failOn.add('prune');

    const result = await run('2026-09-29T07:00:00Z');

    expect(result.posted).toBe(1);
    expect(result.failed).toBe(0);
  });
});
