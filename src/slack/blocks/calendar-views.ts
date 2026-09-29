/**
 * The calendar modals behind the "View week" / "View month" buttons.
 *
 * Public messages are summaries; these are where the detail lives. A modal can show
 * every match of a day without making anyone scroll a channel, and it closes when the
 * reader is done.
 *
 * Two constraints shape everything here:
 *
 *  - **Slack caps a view at 100 blocks.** A week of full draws can exceed that, so
 *    `paginate` splits by day and the view carries Previous/Next. Nothing is ever
 *    silently dropped: a page always says which part of the period it is showing.
 *  - **The data is a snapshot, not live.** Every view states when it was taken, and
 *    says so more loudly once it is old enough to mislead.
 *
 * Pure functions over a `CalendarSnapshot`, so the layouts are asserted exhaustively
 * without Slack, a Worker, or a database.
 */

import { DateTime } from 'luxon';
import type { KnownBlock, ModalView } from '@slack/types';

import type { CalendarSnapshot, SnapshotMatch } from '../../domain/snapshot.ts';
import {
  SLACK_LIMITS,
  context,
  divider,
  escapeText,
  matchCount,
  section,
  tournamentCount,
  truncate,
} from './common.ts';

/** Slack's hard cap on blocks in a view, and the budget we plan against. */
export const VIEW_LIMITS = {
  /** Slack's hard cap on blocks in a view. */
  maxBlocks: 100,
  /**
   * Rendered lines a page of schedule may hold.
   *
   * Budgeted in lines rather than blocks because blocks are a poor proxy for size: a
   * day with sixty matches is one block and an unreadable wall. A normal week is about
   * a hundred lines, so this pages only when a week is genuinely exceptional.
   */
  scheduleLines: 220,
  /**
   * Lines per section block.
   *
   * Keeps any one section well inside Slack's 3,000-character limit, so a very busy day
   * is split across several blocks rather than being truncated.
   */
  linesPerBlock: 40,
} as const;

/** How old a snapshot may be before the view says so prominently. */
export const STALE_AFTER_HOURS = 26;

export const CALENDAR_VIEW_CALLBACK = 'ttv_calendar_view';

export interface CalendarViewOptions {
  /** Which page of the period to render, from 0. Clamped to what exists. */
  readonly page?: number;
  /** Marks the view as built from a drill's snapshot. */
  readonly test?: boolean;
  /** For "how old is this" — injected so the staleness notice is testable. */
  readonly now: Date;
}

export interface PaginationState {
  readonly page: number;
  readonly pageCount: number;
}

/** Everything a click needs to re-open the same view on a different page. */
export interface CalendarViewMetadata {
  readonly periodKey: string;
  readonly variant: 'LIVE' | 'TEST';
  readonly page: number;
}

export const PAGE_ACTION_IDS = {
  previous: 'ttv_calendar_page_previous',
  next: 'ttv_calendar_page_next',
} as const;

export const PAGE_BLOCK_ID = 'ttv_calendar_pagination';

// ---------------------------------------------------------------- the views

/**
 * A week, day by day, with every match listed.
 *
 * Unlike the public weekly summary this does show individual games — that is the whole
 * point of opening it.
 */
export function buildWeekView(snapshot: CalendarSnapshot, options: CalendarViewOptions): ModalView {
  const days = groupByDay(snapshot.matches);
  const pages = paginate(days, VIEW_LIMITS.scheduleLines);
  const page = clamp(options.page ?? 0, pages.length);

  const blocks: KnownBlock[] = [
    ...heading(snapshot, options, [
      `*${dateRange(snapshot.from, snapshot.to, snapshot.timezone)}*`,
      summaryLine(snapshot),
    ]),
  ];

  if (days.length === 0) {
    blocks.push(section('🎾 No Tennis TV matches are scheduled this week.'));
  } else {
    blocks.push(...dayBlocks(pages[page] ?? [], snapshot.timezone));
    blocks.push(...paginationBlocks({ page, pageCount: pages.length }, 'day'));
  }

  return view('Tennis TV — Week', blocks, {
    periodKey: snapshot.periodKey,
    variant: options.test === true ? 'TEST' : 'LIVE',
    page,
  });
}

/**
 * A month: the tournament overview first, then one week of it at a time.
 *
 * A month never tries to render every match at once — several hundred would not fit,
 * and a wall of them answers no question anyone actually has. The overview says what is
 * on; the paged weeks say when.
 */
export function buildMonthView(
  snapshot: CalendarSnapshot,
  options: CalendarViewOptions,
): ModalView {
  const weeks = groupByWeek(snapshot.matches, snapshot.timezone);
  const page = clamp(options.page ?? 0, weeks.length);

  const blocks: KnownBlock[] = [
    ...heading(snapshot, options, [
      `*${monthLabel(snapshot.from, snapshot.timezone)}*`,
      summaryLine(snapshot),
    ]),
  ];

  if (snapshot.tournaments.length === 0) {
    blocks.push(section('🎾 No Tennis TV tournaments are scheduled this month.'));
    return view('Tennis TV — Month', blocks, {
      periodKey: snapshot.periodKey,
      variant: options.test === true ? 'TEST' : 'LIVE',
      page: 0,
    });
  }

  // The overview: what is on this month, regardless of which week is shown below.
  for (const tournament of snapshot.tournaments.slice(0, 15)) {
    blocks.push(
      section(
        [
          `*${tournamentTitle(tournament.name, tournament.sourceUrl)}*`,
          `${dateRange(tournament.startsOn, tournament.endsOn, snapshot.timezone)} · ${
            tournament.matchCount > 0
              ? `${matchCount(tournament.matchCount)} published`
              : '_match times TBC_'
          }`,
        ].join('\n'),
      ),
    );
  }

  if (weeks.length > 0) {
    const current = weeks[page];
    blocks.push(divider());
    blocks.push(
      section(
        `*Week ${String(page + 1)} · ${dateRange(current?.from ?? snapshot.from, current?.to ?? snapshot.to, snapshot.timezone)}*`,
      ),
    );
    blocks.push(...dayBlocks(current?.days ?? [], snapshot.timezone));
    blocks.push(...paginationBlocks({ page, pageCount: weeks.length }, 'week'));
  }

  return view('Tennis TV — Month', blocks, {
    periodKey: snapshot.periodKey,
    variant: options.test === true ? 'TEST' : 'LIVE',
    page,
  });
}

/** Shown when no snapshot exists yet, or the stored one could not be read. */
export function buildUnavailableView(options: {
  readonly period: 'week' | 'month';
  readonly lastRefreshedAt?: Date | null;
  readonly timezone: string;
}): ModalView {
  const blocks: KnownBlock[] = [
    section(
      [
        '*Schedule unavailable*',
        '',
        `The latest Tennis TV calendar snapshot isn't available yet.`,
        'The scheduled refresh runs each morning at 08:00 UK.',
      ].join('\n'),
    ),
  ];

  if (options.lastRefreshedAt != null) {
    blocks.push(
      context(`Last successful refresh: ${stamp(options.lastRefreshedAt, options.timezone)}`),
    );
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Tennis TV', emoji: true },
    close: { type: 'plain_text', text: 'Close', emoji: true },
    blocks,
  };
}

// --------------------------------------------------------------- components

/** Title context: the period, the counts, the timezone, and how fresh this is. */
function heading(
  snapshot: CalendarSnapshot,
  options: CalendarViewOptions,
  lines: readonly string[],
): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  if (options.test === true) {
    // Leads, so nobody mistakes a drill's calendar for the real schedule.
    blocks.push(context('🧪 *Test schedule* · not real Tennis TV data'));
  }

  const generatedAt = new Date(snapshot.generatedAt);
  const ageHours = (options.now.getTime() - generatedAt.getTime()) / 3_600_000;
  const freshness =
    ageHours > STALE_AFTER_HOURS
      ? `⚠️ Updated ${stamp(generatedAt, snapshot.timezone)} — this may be out of date`
      : `Updated ${stamp(generatedAt, snapshot.timezone)}`;

  blocks.push(context([...lines, 'All times UK', freshness].join('\n')));
  blocks.push(divider());

  return blocks;
}

/**
 * The date, then its matches grouped under each tournament.
 *
 * Usually one section per day. A day long enough to approach Slack's per-section
 * character limit is split across several, which is why this returns blocks rather than
 * a block — truncating a day's play would be the one place a match could vanish.
 */
function dayBlocks(days: readonly Day[], timezone: string): KnownBlock[] {
  return days.flatMap((day) => {
    const lines = dayLines(day, timezone);
    const blocks: KnownBlock[] = [];

    for (let index = 0; index < lines.length; index += VIEW_LIMITS.linesPerBlock) {
      blocks.push(section(lines.slice(index, index + VIEW_LIMITS.linesPerBlock).join('\n')));
    }

    return blocks;
  });
}

/** Every line a day renders to: its date, each tournament, and each match. */
function dayLines(day: Day, timezone: string): string[] {
  return [
    `*${dayLabel(day.date, timezone)}*`,
    ...[...groupByTournament(day.matches)].flatMap(([tournamentName, matches]) => [
      `*${escapeText(tournamentName)}*`,
      ...matches.map((match) => matchLine(match, timezone)),
    ]),
  ];
}

/** `*10:41* — Player A vs Player B`, or `TBC` where no time is published. */
function matchLine(match: SnapshotMatch, timezone: string): string {
  const time =
    match.startsAtUtc === null
      ? 'TBC'
      : DateTime.fromISO(match.startsAtUtc, { zone: timezone }).toFormat('HH:mm');

  return `*${time}* — ${escapeText(match.sideOne)} vs ${escapeText(match.sideTwo)}`;
}

/**
 * Previous / Next, and where you are.
 *
 * Omitted entirely when everything fits on one page — a single-page view with disabled
 * arrows is clutter pretending to be navigation.
 */
function paginationBlocks(state: PaginationState, unit: 'day' | 'week'): KnownBlock[] {
  if (state.pageCount <= 1) return [];

  const buttons: Extract<KnownBlock, { type: 'actions' }>['elements'] = [];

  if (state.page > 0) {
    buttons.push({
      type: 'button',
      action_id: PAGE_ACTION_IDS.previous,
      text: { type: 'plain_text', text: `← Previous ${unit}`, emoji: true },
      value: String(state.page - 1),
    });
  }

  if (state.page < state.pageCount - 1) {
    buttons.push({
      type: 'button',
      action_id: PAGE_ACTION_IDS.next,
      text: { type: 'plain_text', text: `Next ${unit} →`, emoji: true },
      value: String(state.page + 1),
    });
  }

  return [
    divider(),
    context(`Page ${String(state.page + 1)} of ${String(state.pageCount)}`),
    { type: 'actions', block_id: PAGE_BLOCK_ID, elements: buttons },
  ];
}

function view(title: string, blocks: KnownBlock[], metadata: CalendarViewMetadata): ModalView {
  return {
    type: 'modal',
    callback_id: CALENDAR_VIEW_CALLBACK,
    title: { type: 'plain_text', text: truncate(title, 24), emoji: true },
    close: { type: 'plain_text', text: 'Close', emoji: true },
    // Not secret, and validated on the way back in — it only ever names which page of
    // which snapshot to re-render, all of which is re-read from D1.
    private_metadata: JSON.stringify(metadata),
    blocks: blocks.slice(0, VIEW_LIMITS.maxBlocks),
  };
}

// ----------------------------------------------------------------- grouping

interface Day {
  readonly date: string;
  readonly matches: readonly SnapshotMatch[];
}

interface Week {
  readonly from: string;
  readonly to: string;
  readonly days: readonly Day[];
}

function groupByDay(matches: readonly SnapshotMatch[]): Day[] {
  const byDay = new Map<string, SnapshotMatch[]>();

  for (const match of matches) {
    const existing = byDay.get(match.onDate);
    if (existing) existing.push(match);
    else byDay.set(match.onDate, [match]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayMatches]) => ({ date, matches: sortByTime(dayMatches) }));
}

/** The month's days, split into ISO weeks so a page is a recognisable unit. */
function groupByWeek(matches: readonly SnapshotMatch[], timezone: string): Week[] {
  const byWeek = new Map<string, Day[]>();

  for (const day of groupByDay(matches)) {
    const parsed = DateTime.fromISO(day.date, { zone: timezone });
    const key = parsed.isValid
      ? `${String(parsed.weekYear)}-${String(parsed.weekNumber).padStart(2, '0')}`
      : day.date;

    const existing = byWeek.get(key);
    if (existing) existing.push(day);
    else byWeek.set(key, [day]);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, days]) => ({
      from: days[0]?.date ?? '',
      to: days[days.length - 1]?.date ?? '',
      days,
    }));
}

function groupByTournament(matches: readonly SnapshotMatch[]): Map<string, SnapshotMatch[]> {
  const groups = new Map<string, SnapshotMatch[]>();
  for (const match of matches) {
    const existing = groups.get(match.tournamentName);
    if (existing) existing.push(match);
    else groups.set(match.tournamentName, [match]);
  }
  return groups;
}

/** Published times first, in order; unpublished ones after, in the order given. */
function sortByTime(matches: readonly SnapshotMatch[]): SnapshotMatch[] {
  return [...matches].sort((a, b) => {
    if (a.startsAtUtc === null && b.startsAtUtc === null) return 0;
    if (a.startsAtUtc === null) return 1;
    if (b.startsAtUtc === null) return -1;
    return a.startsAtUtc.localeCompare(b.startsAtUtc);
  });
}

/**
 * Splits days into pages that each fit the line budget.
 *
 * A day is never split across pages — half a Tuesday on each side of a Next button is
 * worse than an uneven page — so a single enormous day gets a page of its own, where
 * `dayBlocks` spreads it over as many sections as it needs.
 */
export function paginate(days: readonly Day[], budget: number): Day[][] {
  if (days.length === 0) return [];

  const pages: Day[][] = [];
  let current: Day[] = [];
  let used = 0;

  for (const day of days) {
    // The date line, one line per tournament heading, one per match.
    const cost =
      1 + new Set(day.matches.map((match) => match.tournamentName)).size + day.matches.length;

    if (current.length > 0 && used + cost > budget) {
      pages.push(current);
      current = [];
      used = 0;
    }

    current.push(day);
    used += cost;
  }

  if (current.length > 0) pages.push(current);
  return pages;
}

const clamp = (page: number, pageCount: number): number =>
  pageCount === 0 ? 0 : Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);

// ----------------------------------------------------------------- labels

const summaryLine = (snapshot: CalendarSnapshot): string =>
  [
    snapshot.matches.length > 0 ? matchCount(snapshot.matches.length) : '',
    snapshot.tournaments.length > 0 ? tournamentCount(snapshot.tournaments.length) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ') || 'nothing scheduled';

const tournamentTitle = (name: string, sourceUrl: string | null): string =>
  sourceUrl === null ? escapeText(name) : `<${sourceUrl}|${escapeText(name)}>`;

/** `Mon 28 Sep`. */
function dayLabel(isoDate: string, timezone: string): string {
  const parsed = DateTime.fromISO(isoDate, { zone: timezone });
  return parsed.isValid ? parsed.toFormat('ccc d LLL') : isoDate;
}

/** `September 2026`. */
function monthLabel(isoDate: string, timezone: string): string {
  const parsed = DateTime.fromISO(isoDate, { zone: timezone });
  return parsed.isValid ? parsed.toFormat('LLLL yyyy') : isoDate;
}

/** `28 Sep – 4 Oct`, collapsing the month when both ends share it. */
function dateRange(fromIso: string, toIso: string, timezone: string): string {
  const from = DateTime.fromISO(fromIso, { zone: timezone });
  const to = DateTime.fromISO(toIso, { zone: timezone });

  if (!from.isValid || !to.isValid) return `${fromIso}–${toIso}`;
  if (from.hasSame(to, 'day')) return from.toFormat('d LLL');
  if (from.hasSame(to, 'month')) return `${from.toFormat('d')}–${to.toFormat('d LLL')}`;
  return `${from.toFormat('d LLL')} – ${to.toFormat('d LLL')}`;
}

/** `28 Sep, 08:00 UK` — always dated, so "Updated 08:00" cannot mislead across days. */
function stamp(instant: Date, timezone: string): string {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return local.isValid ? `${local.toFormat('d LLL, HH:mm')} UK` : instant.toISOString();
}

export { SLACK_LIMITS };
