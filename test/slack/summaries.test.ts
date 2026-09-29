import { describe, expect, it } from 'vitest';

import {
  buildDailySummary,
  buildMonthlySummary,
  buildWeeklySummary,
} from '../../src/slack/blocks/summaries.ts';
import { RENDER_LIMITS, SLACK_LIMITS, blockText } from '../../src/slack/blocks/common.ts';
import { NAVIGATION_ACTION_IDS } from '../../src/slack/blocks/navigation.ts';
import { ACCENTS } from '../../src/slack/blocks/theme.ts';
import { SUBSCRIPTION_ACTION_IDS } from '../../src/slack/blocks/subscription.ts';
import type { Match, Tournament } from '../../src/domain/types.ts';

const OPTIONS = { timezone: 'Europe/London' };

const aMatch = (overrides: Partial<Match> & { startsAtUtc?: Date | null } = {}): Match => {
  const { startsAtUtc, ...rest } = overrides;
  return {
    id: {
      tournament: { providerTournamentId: '1', year: 2026 },
      providerMatchId: `M${String(Math.random()).slice(2, 8)}`,
    },
    tournamentName: 'ATP Example Open',
    sideOne: { name: 'Player A', isKnown: true },
    sideTwo: { name: 'Player B', isKnown: true },
    schedule: {
      onDate: '2026-09-15',
      startsAtUtc: startsAtUtc === undefined ? new Date('2026-09-15T10:00:00Z') : startsAtUtc,
      notBeforeUtc: null,
      tbcReason: startsAtUtc === null ? 'NOT_PUBLISHED' : null,
    },
    status: 'SCHEDULED',
    rawStatus: { primary: 'U', secondary: 'U', reason: null, unmapped: false },
    round: 'R32',
    court: 'Centre Court',
    isShownOnTennisTv: true,
    isSimulated: false,
    ...rest,
  };
};

const aTournament = (overrides: Partial<Tournament> = {}): Tournament => ({
  id: { providerTournamentId: '4713', year: 2026 },
  name: 'ATP Hangzhou',
  location: 'China',
  city: 'Hangzhou',
  startsOn: '2026-09-23',
  endsOn: '2026-09-29',
  venueUtcOffsetMinutes: 480,
  isShownOnTennisTv: true,
  notShownReason: null,
  sourceUrl: 'https://www.tennistv.com/tournaments/hangzhou-open',
  hasPublishedMatches: false,
  isSimulated: false,
  ...overrides,
});

describe('daily summary', () => {
  it('reads as a compact, scannable list', () => {
    const message = buildDailySummary(
      {
        date: '2026-09-15',
        matches: [
          aMatch({ startsAtUtc: new Date('2026-09-15T10:00:00Z') }),
          aMatch({
            startsAtUtc: new Date('2026-09-15T13:30:00Z'),
            sideOne: { name: 'Player C', isKnown: true },
            sideTwo: { name: 'Player D', isKnown: true },
          }),
        ],
        tournaments: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('🎾 Tennis TV — Today');
    expect(text).toContain('Tue 15 Sep');
    expect(text).toContain('*11:00* — Player A vs Player B');
    expect(text).toContain('*14:30* — Player C vs Player D');
    expect(text).toContain('ATP Example Open');
    expect(text).toContain('All times UK');
  });

  it('never invents a start time it has not been given', () => {
    // A single untimed match is reported as untimed, not guessed at and not hidden.
    const message = buildDailySummary(
      { date: '2026-09-15', matches: [aMatch({ startsAtUtc: null })], tournaments: [] },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('TBC');
    expect(text).toContain('1 match');
  });

  it('names the tournament once per group rather than on every line', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: [aMatch(), aMatch(), aMatch()], tournaments: [] },
      OPTIONS,
    );

    const occurrences = blockText(message.blocks).split('ATP Example Open').length - 1;
    expect(occurrences).toBe(1);
  });

  it('separates matches from different tournaments', () => {
    const message = buildDailySummary(
      {
        date: '2026-09-15',
        matches: [aMatch(), aMatch({ tournamentName: 'ATP Other Open' })],
        tournaments: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('ATP Example Open');
    expect(text).toContain('ATP Other Open');
  });

  it('falls back to tournament windows when no order of play exists', () => {
    const message = buildDailySummary(
      { date: '2026-09-23', matches: [], tournaments: [aTournament()] },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('ATP Hangzhou');
    expect(text).toContain('Match times are published closer to each tournament.');
  });

  it('carries the subscription buttons', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: [aMatch()], tournaments: [] },
      OPTIONS,
    );

    const actions = message.blocks.find((block) => block.type === 'actions');
    expect(actions).toBeDefined();
    expect(JSON.stringify(actions)).toContain(SUBSCRIPTION_ACTION_IDS.optIn);
    expect(JSON.stringify(actions)).toContain(SUBSCRIPTION_ACTION_IDS.optOut);
  });

  it('renders BST and GMT from the same UTC instants', () => {
    const summer = buildDailySummary(
      {
        date: '2026-08-15',
        matches: [aMatch({ startsAtUtc: new Date('2026-08-15T18:04:00Z') })],
        tournaments: [],
      },
      OPTIONS,
    );
    const winter = buildDailySummary(
      {
        date: '2026-01-15',
        matches: [aMatch({ startsAtUtc: new Date('2026-01-15T19:04:00Z') })],
        tournaments: [],
      },
      OPTIONS,
    );

    expect(blockText(summer.blocks)).toContain('19:04');
    expect(blockText(winter.blocks)).toContain('19:04');
  });
});

describe('weekly summary', () => {
  it('groups matches by day', () => {
    const message = buildWeeklySummary(
      {
        from: '2026-09-14',
        to: '2026-09-20',
        matches: [
          aMatch({ schedule: { ...aMatch().schedule, onDate: '2026-09-15' } }),
          aMatch({
            schedule: {
              onDate: '2026-09-17',
              startsAtUtc: new Date('2026-09-17T12:00:00Z'),
              notBeforeUtc: null,
              tbcReason: null,
            },
          }),
        ],
        tournaments: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('Tue 15 Sep');
    expect(text).toContain('Thu 17 Sep');
    // Days in order, not interleaved.
    expect(text.indexOf('Tue 15 Sep')).toBeLessThan(text.indexOf('Thu 17 Sep'));
  });

  it('omits days with nothing on them', () => {
    const message = buildWeeklySummary(
      {
        from: '2026-09-14',
        to: '2026-09-20',
        matches: [aMatch({ schedule: { ...aMatch().schedule, onDate: '2026-09-15' } })],
        tournaments: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('Tue 15 Sep');
    expect(text).not.toContain('Wed 16 Sep');
  });

  it('posts even when the week is empty', () => {
    // PROJECT_SPEC.md §4.2 — weekly always posts.
    const message = buildWeeklySummary(
      { from: '2026-09-14', to: '2026-09-20', matches: [], tournaments: [] },
      OPTIONS,
    );

    expect(blockText(message.blocks)).toContain(
      '🎾 No Tennis TV matches are currently scheduled this week.',
    );
    expect(message.blocks.some((block) => block.type === 'actions')).toBe(true);
  });

  it('lists tournaments whose order of play is not out yet', () => {
    const message = buildWeeklySummary(
      {
        from: '2026-09-21',
        to: '2026-09-27',
        matches: [aMatch({ tournamentName: 'ATP Chengdu' })],
        tournaments: [aTournament(), aTournament({ name: 'ATP Chengdu' })],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('Also this week');
    expect(text).toContain('ATP Hangzhou');
  });
});

describe('monthly summary', () => {
  it('lists tournament windows rather than every match', () => {
    const message = buildMonthlySummary(
      {
        from: '2026-09-01',
        to: '2026-09-30',
        tournaments: [aTournament()],
        matches: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('🎾 Tennis TV — September 2026');
    expect(text).toContain('23–29 Sep');
    expect(text).toContain('ATP Hangzhou');
    expect(text).toContain('match times TBC');
  });

  it('links to the tournament when a source URL exists', () => {
    const message = buildMonthlySummary(
      { from: '2026-09-01', to: '2026-09-30', tournaments: [aTournament()], matches: [] },
      OPTIONS,
    );

    expect(blockText(message.blocks)).toContain(
      '<https://www.tennistv.com/tournaments/hangzhou-open|ATP Hangzhou>',
    );
  });

  it('reports a match count where detail already exists', () => {
    const message = buildMonthlySummary(
      {
        from: '2026-09-01',
        to: '2026-09-30',
        tournaments: [aTournament({ name: 'ATP Example Open', hasPublishedMatches: true })],
        matches: [aMatch(), aMatch()],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('2 matches currently published');
    expect(text).not.toContain('Player A vs Player B');
  });

  it('stays readable and within Slack limits during a very busy month', () => {
    const tournaments = Array.from({ length: 40 }, (_, index) =>
      aTournament({
        id: { providerTournamentId: String(index), year: 2026 },
        name: `ATP Tournament ${String(index)}`,
        startsOn: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
        endsOn: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
      }),
    );

    const message = buildMonthlySummary(
      { from: '2026-09-01', to: '2026-09-30', tournaments, matches: [] },
      OPTIONS,
    );

    expect(message.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.maxBlocks);
    // Forty tournaments do not become forty blocks: the list is capped and the
    // remainder is stated as a count.
    expect(message.blocks.length).toBeLessThan(RENDER_LIMITS.monthlyTournaments + 8);
    expect(blockText(message.blocks)).toContain('30 tournaments this month');
  });

  it('posts even when the month is empty', () => {
    const message = buildMonthlySummary(
      { from: '2026-09-01', to: '2026-09-30', tournaments: [], matches: [] },
      OPTIONS,
    );

    expect(blockText(message.blocks)).toContain(
      '🎾 No Tennis TV matches are currently scheduled this month.',
    );
  });

  it('orders tournaments by start date', () => {
    const message = buildMonthlySummary(
      {
        from: '2026-09-01',
        to: '2026-09-30',
        tournaments: [
          aTournament({ name: 'Later', startsOn: '2026-09-20', endsOn: '2026-09-26' }),
          aTournament({ name: 'Earlier', startsOn: '2026-09-05', endsOn: '2026-09-11' }),
        ],
        matches: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text.indexOf('Earlier')).toBeLessThan(text.indexOf('Later'));
  });
});

describe('every summary', () => {
  const all = [
    buildDailySummary({ date: '2026-09-15', matches: [aMatch()], tournaments: [] }, OPTIONS),
    buildWeeklySummary(
      { from: '2026-09-14', to: '2026-09-20', matches: [aMatch()], tournaments: [] },
      OPTIONS,
    ),
    buildMonthlySummary(
      { from: '2026-09-01', to: '2026-09-30', tournaments: [aTournament()], matches: [] },
      OPTIONS,
    ),
  ];

  it.each(['@channel', '@here', '@everyone'])('never contains %s', (token) => {
    for (const message of all) {
      expect(blockText(message.blocks)).not.toContain(token);
      expect(message.text).not.toContain(token);
    }
  });

  it('always carries a plain-text fallback', () => {
    for (const message of all) {
      expect(message.text.length).toBeGreaterThan(0);
      expect(message.text.length).toBeLessThanOrEqual(3000);
    }
  });

  it('always stays within Slack block limits', () => {
    for (const message of all) expect(message.blocks.length).toBeLessThanOrEqual(50);
  });

  it('escapes markup in externally sourced names', () => {
    const message = buildDailySummary(
      {
        date: '2026-09-15',
        matches: [aMatch({ sideOne: { name: '<script>', isKnown: true } })],
        tournaments: [],
      },
      OPTIONS,
    );

    const text = blockText(message.blocks);
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// The redesign: summaries, not listings.
// ---------------------------------------------------------------------------

/** `count` matches at a tournament, `timed` of which have a published start. */
const schedule = (
  tournamentName: string,
  count: number,
  timed: number,
  onDate = '2026-09-15',
): Match[] =>
  Array.from({ length: count }, (_, index) =>
    aMatch({
      tournamentName,
      id: {
        tournament: { providerTournamentId: tournamentName, year: 2026 },
        providerMatchId: `M${String(index)}`,
      },
      sideOne: { name: `Player ${String(index)}A`, isKnown: true },
      sideTwo: { name: `Player ${String(index)}B`, isKnown: true },
      startsAtUtc:
        index < timed ? new Date(`${onDate}T${String(8 + index).padStart(2, '0')}:00:00Z`) : null,
      schedule: {
        onDate,
        startsAtUtc:
          index < timed ? new Date(`${onDate}T${String(8 + index).padStart(2, '0')}:00:00Z`) : null,
        notBeforeUtc: null,
        tbcReason: index < timed ? null : 'NOT_PUBLISHED',
      },
    }),
  );

describe('collapsing matches with no published time', () => {
  it('replaces a wall of TBC rows with one count', () => {
    // The failure this exists to prevent: 20 identical "TBC — A vs B" lines.
    const message = buildDailySummary(
      { date: '2026-09-15', matches: schedule('Beijing', 22, 2), tournaments: [] },
      OPTIONS,
    );
    const text = blockText(message.blocks);

    expect(text).toContain('+ 20 matches — time TBC');
    // The two with times are still listed individually.
    expect(text).toContain('*09:00*');
    expect(text.match(/TBC/g)?.length).toBe(1);
  });

  it('never hides that the matches exist', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: schedule('Beijing', 30, 0), tournaments: [] },
      OPTIONS,
    );

    expect(blockText(message.blocks)).toContain('30 matches');
  });

  it('gives a tournament with no times at all a single compact line', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: schedule('Tokyo', 13, 0), tournaments: [] },
      OPTIONS,
    );
    const text = blockText(message.blocks);

    expect(text).toContain('*Tokyo*');
    expect(text).toContain('13 matches scheduled · times TBC');
  });

  it('counts them in the header even when collapsed', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: schedule('Beijing', 18, 3), tournaments: [] },
      OPTIONS,
    );

    expect(blockText(message.blocks)).toContain('18 matches');
  });
});

describe('daily message structure', () => {
  const busy = {
    date: '2026-09-15',
    matches: [
      ...schedule('Beijing', 4, 2),
      ...schedule('Chengdu', 4, 2),
      ...schedule('Tokyo', 6, 0),
    ],
    tournaments: [],
  };

  it('follows header → context → divider → content → divider → actions', () => {
    const types = buildDailySummary(busy, OPTIONS).blocks.map((block) => block.type);

    expect(types[0]).toBe('header');
    expect(types[1]).toBe('context');
    expect(types[2]).toBe('divider');
    expect(types.at(-3)).toBe('divider');
    expect(types.at(-2)).toBe('actions');
    expect(types.at(-1)).toBe('actions');
  });

  it('groups by tournament, naming each once', () => {
    const text = blockText(buildDailySummary(busy, OPTIONS).blocks);

    expect(text.match(/\*Beijing\*/g)?.length).toBe(1);
    expect(text).toContain('*Chengdu*');
    expect(text).toContain('*Tokyo*');
  });

  it('states the day, the counts and the timezone in one context line', () => {
    const text = blockText(buildDailySummary(busy, OPTIONS).blocks);

    expect(text).toContain('Tue 15 Sep');
    expect(text).toContain('14 matches');
    expect(text).toContain('All times UK');
  });

  it('emphasises confirmed start times so they scan', () => {
    expect(blockText(buildDailySummary(busy, OPTIONS).blocks)).toMatch(/\*\d{2}:\d{2}\*/);
  });

  it('does not fake table alignment with runs of whitespace', () => {
    expect(blockText(buildDailySummary(busy, OPTIONS).blocks)).not.toMatch(/ {4}/);
  });
});

describe('a very large day', () => {
  const huge = {
    date: '2026-09-15',
    matches: Array.from({ length: 15 }, (_, index) =>
      schedule(`Tournament ${String(index)}`, 20, 10),
    ).flat(),
    tournaments: [],
  };

  it('stays inside Slack block limits', () => {
    expect(buildDailySummary(huge, OPTIONS).blocks.length).toBeLessThanOrEqual(
      SLACK_LIMITS.maxBlocks,
    );
  });

  it('caps the tournaments shown and states how many are left', () => {
    const message = buildDailySummary(huge, OPTIONS);
    const text = blockText(message.blocks);

    expect(text).toContain(`+ ${String(15 - RENDER_LIMITS.dailyTournaments)} tournaments`);
  });

  it('caps the matches shown per tournament and states how many are left', () => {
    const text = blockText(buildDailySummary(huge, OPTIONS).blocks);
    expect(text).toContain(
      `+ ${String(10 - RENDER_LIMITS.dailyMatchesPerTournament)} matches later`,
    );
  });

  it('keeps every section inside Slack character limits', () => {
    for (const block of buildDailySummary(huge, OPTIONS).blocks) {
      if (block.type === 'section' && block.text) {
        expect(block.text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.maxSectionText);
      }
    }
  });

  it('still ends with both action rows', () => {
    const types = buildDailySummary(huge, OPTIONS).blocks.map((block) => block.type);
    expect(types.at(-2)).toBe('actions');
    expect(types.at(-1)).toBe('actions');
  });
});

describe('weekly overview', () => {
  const week = {
    from: '2026-09-28',
    to: '2026-10-04',
    matches: [
      ...schedule('Beijing', 4, 4, '2026-09-28'),
      ...schedule('Tokyo', 6, 2, '2026-09-28'),
      ...schedule('Chengdu', 18, 0, '2026-09-30'),
    ],
    tournaments: [],
  };

  it('shows one line per tournament per day, not one per match', () => {
    const text = blockText(buildWeeklySummary(week, OPTIONS).blocks);

    expect(text).toContain('Beijing · ');
    // No individual match ever appears in the weekly overview.
    expect(text).not.toContain('Player 0A vs Player 0B');
  });

  it('renders a range of start times when several are known', () => {
    expect(blockText(buildWeeklySummary(week, OPTIONS).blocks)).toMatch(
      /Beijing · \d{2}:\d{2}–\d{2}:\d{2}/,
    );
  });

  it('says so honestly when only some of a group has a time', () => {
    expect(blockText(buildWeeklySummary(week, OPTIONS).blocks)).toContain('Tokyo · 09:00–TBC');
  });

  it('collapses a day with no published times to a count', () => {
    expect(blockText(buildWeeklySummary(week, OPTIONS).blocks)).toContain('18 matches · times TBC');
  });

  it('uses "from" rather than a range when only one time is known', () => {
    const single = {
      ...week,
      matches: schedule('Beijing', 1, 1, '2026-09-28'),
    };

    expect(blockText(buildWeeklySummary(single, OPTIONS).blocks)).toContain('from 09:00');
  });

  it('never implies an end of play it was not given', () => {
    const text = blockText(buildWeeklySummary(week, OPTIONS).blocks);
    expect(text).toContain('first and last start time, not an end of play');
  });

  it('posts a plain statement when the week is empty', () => {
    const message = buildWeeklySummary(
      { from: '2026-09-28', to: '2026-10-04', matches: [], tournaments: [] },
      OPTIONS,
    );

    expect(blockText(message.blocks)).toContain('No Tennis TV matches are currently scheduled');
    // Still a full message, buttons and all.
    expect(message.blocks.map((block) => block.type).at(-1)).toBe('actions');
  });
});

describe('monthly overview', () => {
  const month = {
    from: '2026-10-01',
    to: '2026-10-31',
    tournaments: [
      aTournament({ name: 'Shanghai Masters', startsOn: '2026-10-01', endsOn: '2026-10-12' }),
      aTournament({ name: 'Stockholm Open', startsOn: '2026-10-19', endsOn: '2026-10-25' }),
    ],
    matches: schedule('Shanghai Masters', 42, 42, '2026-10-02'),
  };

  it('summarises tournaments and windows, not individual matches', () => {
    const text = blockText(buildMonthlySummary(month, OPTIONS).blocks);

    expect(text).toContain('Shanghai Masters');
    expect(text).toContain('1–12 Oct');
    expect(text).not.toContain('Player 0A vs Player 0B');
  });

  it('reports what is published for each tournament', () => {
    const text = blockText(buildMonthlySummary(month, OPTIONS).blocks);

    expect(text).toContain('42 matches currently published');
    expect(text).toContain('match times TBC');
  });

  it('names the month and year in the header', () => {
    expect(blockText(buildMonthlySummary(month, OPTIONS).blocks)).toContain(
      '🎾 Tennis TV — October 2026',
    );
  });
});

describe('accent colours', () => {
  it.each([
    [
      'daily',
      () =>
        buildDailySummary({ date: '2026-09-15', matches: [aMatch()], tournaments: [] }, OPTIONS),
    ],
    [
      'weekly',
      () =>
        buildWeeklySummary(
          { from: '2026-09-28', to: '2026-10-04', matches: [], tournaments: [] },
          OPTIONS,
        ),
    ],
    [
      'monthly',
      () =>
        buildMonthlySummary(
          { from: '2026-10-01', to: '2026-10-31', tournaments: [], matches: [] },
          OPTIONS,
        ),
    ],
  ])('%s carries the schedule accent', (_name, build) => {
    expect(build().accent).toBe(ACCENTS.schedule);
  });
});

describe('buttons', () => {
  const actionIds = (blocks: readonly { type: string }[]): string[] =>
    blocks
      .filter(
        (block): block is { type: 'actions'; elements: { action_id?: string }[] } =>
          block.type === 'actions',
      )
      .flatMap((block) => block.elements.map((element) => element.action_id ?? ''));

  it('daily offers opt in/out, then week and month', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: [aMatch()], tournaments: [] },
      OPTIONS,
    );

    expect(actionIds(message.blocks)).toEqual([
      SUBSCRIPTION_ACTION_IDS.optIn,
      SUBSCRIPTION_ACTION_IDS.optOut,
      NAVIGATION_ACTION_IDS.viewWeek,
      NAVIGATION_ACTION_IDS.viewMonth,
    ]);
  });

  it('weekly offers the full week and the month', () => {
    const message = buildWeeklySummary(
      { from: '2026-09-28', to: '2026-10-04', matches: [], tournaments: [] },
      OPTIONS,
    );

    expect(actionIds(message.blocks)).toEqual([
      SUBSCRIPTION_ACTION_IDS.optIn,
      SUBSCRIPTION_ACTION_IDS.optOut,
      NAVIGATION_ACTION_IDS.viewFullWeek,
      NAVIGATION_ACTION_IDS.viewMonth,
    ]);
  });

  it('monthly offers the full month', () => {
    const message = buildMonthlySummary(
      { from: '2026-10-01', to: '2026-10-31', tournaments: [], matches: [] },
      OPTIONS,
    );

    expect(actionIds(message.blocks)).toEqual([
      SUBSCRIPTION_ACTION_IDS.optIn,
      SUBSCRIPTION_ACTION_IDS.optOut,
      NAVIGATION_ACTION_IDS.viewFullMonth,
    ]);
  });

  it('splits subscription and navigation into separate rows', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: [aMatch()], tournaments: [] },
      OPTIONS,
    );
    const rows = message.blocks.filter((block) => block.type === 'actions');

    expect(rows).toHaveLength(2);
  });
});

describe('fallback text', () => {
  it('describes the daily message without emoji or colour', () => {
    const message = buildDailySummary(
      { date: '2026-09-15', matches: schedule('Beijing', 12, 6), tournaments: [] },
      OPTIONS,
    );

    expect(message.text).toBe('Tennis TV: 12 matches today');
  });

  it('describes the weekly message by its range', () => {
    const message = buildWeeklySummary(
      { from: '2026-09-28', to: '2026-10-04', matches: [], tournaments: [] },
      OPTIONS,
    );

    expect(message.text).toContain('weekly schedule for 28 Sep – 4 Oct');
  });

  it('describes the monthly message by its month', () => {
    const message = buildMonthlySummary(
      { from: '2026-10-01', to: '2026-10-31', tournaments: [aTournament()], matches: [] },
      OPTIONS,
    );

    expect(message.text).toContain('October 2026');
  });

  it.each([
    [
      'daily',
      () =>
        buildDailySummary({ date: '2026-09-15', matches: [aMatch()], tournaments: [] }, OPTIONS),
    ],
    [
      'weekly',
      () =>
        buildWeeklySummary(
          { from: '2026-09-28', to: '2026-10-04', matches: [], tournaments: [] },
          OPTIONS,
        ),
    ],
    [
      'monthly',
      () =>
        buildMonthlySummary(
          { from: '2026-10-01', to: '2026-10-31', tournaments: [], matches: [] },
          OPTIONS,
        ),
    ],
  ])('%s stays inside the fallback length limit', (_name, build) => {
    expect(build().text.length).toBeLessThanOrEqual(SLACK_LIMITS.maxFallbackText);
  });
});
