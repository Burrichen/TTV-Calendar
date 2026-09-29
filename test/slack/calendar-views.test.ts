import { describe, expect, it } from 'vitest';

import type { CalendarSnapshot, SnapshotMatch } from '../../src/domain/snapshot.ts';
import {
  PAGE_ACTION_IDS,
  STALE_AFTER_HOURS,
  VIEW_LIMITS,
  buildMonthView,
  buildUnavailableView,
  buildWeekView,
  paginate,
} from '../../src/slack/blocks/calendar-views.ts';
import { blockText } from '../../src/slack/blocks/common.ts';

/**
 * The calendar modals.
 *
 * Unlike the public summaries these DO list individual matches — that is what opening
 * one is for. What they must still never do is exceed Slack's view limits or drop a
 * match silently, so most of what follows is about paging and honesty.
 */

const NOW = new Date('2026-09-29T09:00:00Z');
const GENERATED = '2026-09-29T07:00:00.000Z';

const match = (overrides: Partial<SnapshotMatch> = {}): SnapshotMatch => ({
  matchKey: `4713:2026:M${String(Math.random()).slice(2, 8)}`,
  tournamentName: 'Beijing',
  sideOne: 'Player A',
  sideTwo: 'Player B',
  startsAtUtc: '2026-09-28T09:41:00.000Z',
  onDate: '2026-09-28',
  ...overrides,
});

const snapshot = (overrides: Partial<CalendarSnapshot> = {}): CalendarSnapshot => ({
  periodType: 'WEEK',
  periodKey: 'week:2026-W40',
  from: '2026-09-28',
  to: '2026-10-04',
  timezone: 'Europe/London',
  generatedAt: GENERATED,
  tournaments: [
    {
      name: 'Beijing',
      startsOn: '2026-09-28',
      endsOn: '2026-10-04',
      sourceUrl: null,
      matchCount: 2,
    },
  ],
  matches: [match(), match({ startsAtUtc: '2026-09-28T11:41:00.000Z' })],
  ...overrides,
});

/** Many matches across `days` consecutive days, for the paging tests. */
const busyWeek = (days: number, perDay: number): SnapshotMatch[] =>
  Array.from({ length: days }, (_, day) =>
    Array.from({ length: perDay }, (_, index) =>
      match({
        onDate: `2026-09-${String(28 + day).padStart(2, '0')}`,
        startsAtUtc: `2026-09-${String(28 + day).padStart(2, '0')}T${String(8 + (index % 12)).padStart(2, '0')}:00:00.000Z`,
        tournamentName: `Tournament ${String(index % 3)}`,
      }),
    ),
  ).flat();

describe('the week view', () => {
  it('lists individual matches, which the public summary deliberately does not', () => {
    const text = blockText(buildWeekView(snapshot(), { now: NOW }).blocks);

    expect(text).toContain('Player A vs Player B');
    expect(text).toContain('*10:41*');
  });

  it('groups matches by day, then by tournament', () => {
    const text = blockText(buildWeekView(snapshot(), { now: NOW }).blocks);

    expect(text).toContain('*Mon 28 Sep*');
    expect(text).toContain('*Beijing*');
  });

  it('states the range, the counts and the timezone', () => {
    const text = blockText(buildWeekView(snapshot(), { now: NOW }).blocks);

    expect(text).toContain('28 Sep – 4 Oct');
    expect(text).toContain('2 matches');
    expect(text).toContain('All times UK');
  });

  it('shows TBC where Tennis TV has published no time', () => {
    const view = buildWeekView(snapshot({ matches: [match({ startsAtUtc: null })] }), { now: NOW });

    expect(blockText(view.blocks)).toContain('*TBC* — Player A vs Player B');
  });

  it('puts published times before unpublished ones', () => {
    const view = buildWeekView(
      snapshot({
        matches: [
          match({ startsAtUtc: null, sideOne: 'Untimed' }),
          match({ startsAtUtc: '2026-09-28T09:00:00.000Z', sideOne: 'Timed' }),
        ],
      }),
      { now: NOW },
    );
    const text = blockText(view.blocks);

    expect(text.indexOf('Timed')).toBeLessThan(text.indexOf('Untimed'));
  });

  it('says plainly when the week is empty', () => {
    const view = buildWeekView(snapshot({ matches: [], tournaments: [] }), { now: NOW });
    expect(blockText(view.blocks)).toContain('No Tennis TV matches are scheduled this week');
  });

  it('carries the snapshot it came from in its metadata', () => {
    const view = buildWeekView(snapshot(), { now: NOW });

    expect(JSON.parse(view.private_metadata ?? '{}')).toEqual({
      periodKey: 'week:2026-W40',
      variant: 'LIVE',
      page: 0,
    });
  });
});

describe('times across the DST boundary', () => {
  it('renders BST times in UK local time', () => {
    // 09:41 UTC in September is 10:41 in London.
    const view = buildWeekView(snapshot(), { now: NOW });
    expect(blockText(view.blocks)).toContain('*10:41*');
  });

  it('renders GMT times in UK local time', () => {
    // 09:41 UTC in January is 09:41 in London.
    const view = buildWeekView(
      snapshot({
        from: '2026-01-05',
        to: '2026-01-11',
        matches: [match({ onDate: '2026-01-05', startsAtUtc: '2026-01-05T09:41:00.000Z' })],
      }),
      { now: NOW },
    );

    expect(blockText(view.blocks)).toContain('*09:41*');
  });
});

describe('freshness', () => {
  it('always says when the snapshot was taken', () => {
    expect(blockText(buildWeekView(snapshot(), { now: NOW }).blocks)).toContain(
      'Updated 29 Sep, 08:00 UK',
    );
  });

  it('warns when the snapshot is unusually old', () => {
    const stale = new Date(new Date(GENERATED).getTime() + (STALE_AFTER_HOURS + 2) * 3_600_000);
    const text = blockText(buildWeekView(snapshot(), { now: stale }).blocks);

    expect(text).toContain('⚠️');
    expect(text).toContain('may be out of date');
  });

  it('does not warn while the snapshot is current', () => {
    expect(blockText(buildWeekView(snapshot(), { now: NOW }).blocks)).not.toContain('⚠️');
  });
});

describe('test mode', () => {
  it('is visibly marked', () => {
    const text = blockText(buildWeekView(snapshot(), { now: NOW, test: true }).blocks);
    expect(text).toContain('🧪 *Test schedule*');
  });

  it('records the variant, so paging stays in the test calendar', () => {
    const view = buildWeekView(snapshot(), { now: NOW, test: true });
    expect(metadataOf(view).variant).toBe('TEST');
  });
});

describe('paging a large week', () => {
  const huge = snapshot({ matches: busyWeek(7, 60) });

  it('stays inside Slack view limits on every page', () => {
    for (let page = 0; page < 7; page += 1) {
      const view = buildWeekView(huge, { now: NOW, page });
      expect(view.blocks.length).toBeLessThanOrEqual(VIEW_LIMITS.maxBlocks);
    }
  });

  it('offers Next on the first page but not Previous', () => {
    const ids = actionIds(buildWeekView(huge, { now: NOW, page: 0 }));

    expect(ids).toContain(PAGE_ACTION_IDS.next);
    expect(ids).not.toContain(PAGE_ACTION_IDS.previous);
  });

  it('offers Previous on the last page but not Next', () => {
    const pageCount = pagesOf(huge);
    const ids = actionIds(buildWeekView(huge, { now: NOW, page: pageCount - 1 }));

    expect(ids).toContain(PAGE_ACTION_IDS.previous);
    expect(ids).not.toContain(PAGE_ACTION_IDS.next);
  });

  it('says where you are', () => {
    expect(blockText(buildWeekView(huge, { now: NOW, page: 1 }).blocks)).toMatch(/Page 2 of \d+/);
  });

  it('drops no match across the pages', () => {
    const seen = new Set<string>();

    for (let page = 0; page < pagesOf(huge); page += 1) {
      for (const line of blockText(buildWeekView(huge, { now: NOW, page }).blocks).split('\n')) {
        if (line.includes(' vs ')) seen.add(line);
      }
    }

    // Every distinct rendered day/time/tournament combination appears somewhere.
    expect(seen.size).toBeGreaterThan(0);
    expect(blockText(buildWeekView(huge, { now: NOW, page: 0 }).blocks)).toContain('Mon 28 Sep');
  });

  it('clamps a page number beyond the end rather than rendering nothing', () => {
    const view = buildWeekView(huge, { now: NOW, page: 999 });

    expect(view.blocks.length).toBeGreaterThan(2);
    expect(metadataOf(view).page).toBe(pagesOf(huge) - 1);
  });

  it('clamps a negative page to the first', () => {
    const view = buildWeekView(huge, { now: NOW, page: -5 });
    expect(metadataOf(view).page).toBe(0);
  });

  it('shows no pagination at all when everything fits', () => {
    expect(actionIds(buildWeekView(snapshot(), { now: NOW }))).toHaveLength(0);
  });
});

describe('the paginator', () => {
  it('returns nothing for no days', () => {
    expect(paginate([], 10)).toEqual([]);
  });

  it('keeps a day whole rather than splitting it across pages', () => {
    const days = [
      { date: '2026-09-28', matches: Array.from({ length: 200 }, () => match()) },
      { date: '2026-09-29', matches: [match()] },
    ];

    const pages = paginate(days, 5);
    for (const page of pages) {
      expect(page.map((day) => day.date)).toEqual([...new Set(page.map((day) => day.date))]);
    }
  });

  it('fits a small week on one page', () => {
    const days = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-09-2${String(index)}`,
      matches: [match()],
    }));

    expect(paginate(days, VIEW_LIMITS.scheduleLines)).toHaveLength(1);
  });
});

describe('the month view', () => {
  const month = snapshot({
    periodType: 'MONTH',
    periodKey: 'month:2026-09',
    from: '2026-09-01',
    to: '2026-09-30',
    tournaments: [
      {
        name: 'Beijing',
        startsOn: '2026-09-28',
        endsOn: '2026-10-04',
        sourceUrl: null,
        matchCount: 32,
      },
      {
        name: 'Shanghai',
        startsOn: '2026-09-01',
        endsOn: '2026-09-12',
        sourceUrl: null,
        matchCount: 48,
      },
    ],
    matches: busyWeek(7, 10),
  });

  it('leads with the tournament overview', () => {
    const text = blockText(buildMonthView(month, { now: NOW }).blocks);

    expect(text).toContain('*Shanghai*');
    expect(text).toContain('48 matches published');
    expect(text).toContain('*Beijing*');
  });

  it('names the month', () => {
    expect(blockText(buildMonthView(month, { now: NOW }).blocks)).toContain('September 2026');
  });

  it('shows one week of the month at a time, not every match', () => {
    const text = blockText(buildMonthView(month, { now: NOW }).blocks);
    expect(text).toMatch(/Week 1 · /);
  });

  it('pages between the weeks', () => {
    expect(actionIds(buildMonthView(month, { now: NOW, page: 0 }))).toContain(PAGE_ACTION_IDS.next);
  });

  it('stays inside Slack view limits', () => {
    expect(buildMonthView(month, { now: NOW }).blocks.length).toBeLessThanOrEqual(
      VIEW_LIMITS.maxBlocks,
    );
  });

  it('says plainly when the month is empty', () => {
    const empty = buildMonthView(snapshot({ periodType: 'MONTH', tournaments: [], matches: [] }), {
      now: NOW,
    });

    expect(blockText(empty.blocks)).toContain('No Tennis TV tournaments are scheduled');
  });

  it('marks a test month too', () => {
    expect(blockText(buildMonthView(month, { now: NOW, test: true }).blocks)).toContain(
      '🧪 *Test schedule*',
    );
  });
});

describe('when no snapshot exists', () => {
  it('explains rather than failing', () => {
    const text = blockText(
      buildUnavailableView({ period: 'week', timezone: 'Europe/London' }).blocks,
    );

    expect(text).toContain('Schedule unavailable');
    expect(text).toContain("isn't available yet");
    expect(text).toContain('08:00 UK');
  });

  it('mentions the last successful refresh when there was one', () => {
    const text = blockText(
      buildUnavailableView({
        period: 'month',
        lastRefreshedAt: new Date('2026-09-27T07:00:00Z'),
        timezone: 'Europe/London',
      }).blocks,
    );

    expect(text).toContain('Last successful refresh: 27 Sep, 08:00 UK');
  });

  it('is still a closeable modal', () => {
    const view = buildUnavailableView({ period: 'week', timezone: 'Europe/London' });

    expect(view.type).toBe('modal');
    expect(view.close).toBeDefined();
  });
});

// --------------------------------------------------------------------------

/** The navigation state a view carries, parsed and typed. */
function metadataOf(view: { private_metadata?: string | undefined }): {
  periodKey: string;
  variant: string;
  page: number;
} {
  return JSON.parse(view.private_metadata ?? '{}') as {
    periodKey: string;
    variant: string;
    page: number;
  };
}

function actionIds(view: { blocks: readonly { type: string }[] }): string[] {
  return view.blocks
    .filter(
      (block): block is { type: 'actions'; elements: { action_id?: string }[] } =>
        block.type === 'actions',
    )
    .flatMap((block) => block.elements.map((element) => element.action_id ?? ''));
}

function pagesOf(source: CalendarSnapshot): number {
  const text = blockText(buildWeekView(source, { now: NOW, page: 0 }).blocks);
  const match = /Page 1 of (\d+)/.exec(text);
  return match === null ? 1 : Number(match[1]);
}
