/**
 * Block Kit for the daily, weekly and monthly schedules.
 *
 * These are **summaries, not listings**. A public message answers four questions —
 * what is on, when can we test, which tournaments, and where is the detail — and it
 * answers them without scrolling. Everything else belongs behind the view buttons.
 *
 * Two rules keep that true whatever Tennis TV sends:
 *
 *  - **matches without a published time are collapsed into a count.** A day can easily
 *    hold thirty matches with no order of play yet; thirty identical `TBC` lines is a
 *    data dump, `+ 30 matches — time TBC` is information. The count is never hidden.
 *  - **every list is capped and the overflow is stated.** `RENDER_LIMITS` decides how
 *    much is shown, so the size of the message does not depend on how busy the day is.
 *
 * All three share one shape: header, context, divider, content, divider, subscription
 * actions, navigation actions. Recognisable at a glance, and the same skeleton to read.
 */

import { DateTime } from 'luxon';
import type { KnownBlock } from '@slack/types';

import type { Match, Tournament } from '../../domain/types.ts';
import {
  RENDER_LIMITS,
  type BuiltMessage,
  capBlocks,
  context,
  divider,
  escapeText,
  fallback,
  hasKnownTime,
  header,
  matchCount,
  matchLine,
  section,
  tbcSummary,
  timeLabel,
  tournamentCount,
} from './common.ts';
import { NAVIGATION_ROWS, navigationActions, type NavigationButton } from './navigation.ts';
import { subscriptionActions } from './subscription.ts';
import { ACCENTS } from './theme.ts';

export type { BuiltMessage } from './common.ts';

export interface SummaryOptions {
  readonly timezone: string;
}

const ALL_TIMES_UK = 'All times UK';

/**
 * The context line under the header: what period, how much, and the timezone.
 *
 * The timezone note is dropped when nothing is scheduled — "All times UK" under "no
 * matches" is noise, and a summary earns trust by not saying things that mean nothing.
 */
function contextLine(period: string, matches: number, tournaments: number): string {
  const counts = countSummary(matches, tournaments);
  const parts = [period === '' ? '' : `*${period}*`, counts];
  if (matches > 0 || tournaments > 0) parts.push(ALL_TIMES_UK);
  return parts.filter((part) => part !== '').join(' · ');
}

// ------------------------------------------------------------------- daily

export interface DailySummaryView {
  /** Local calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly matches: readonly Match[];
  /** Tournaments running that day — context when no order of play exists yet. */
  readonly tournaments: readonly Tournament[];
}

/**
 * Today, grouped by tournament.
 *
 * ```
 * 🎾 Tennis TV — Today
 * Tue 29 Sep · 18 matches · 4 tournaments
 * All times UK
 * ─────────────
 * Beijing
 * 10:41 — Player A vs Player B
 * 12:41 — Player C vs Player D
 * + 3 matches — time TBC
 * ```
 */
export function buildDailySummary(view: DailySummaryView, options: SummaryOptions): BuiltMessage {
  const heading = '🎾 Tennis TV — Today';
  const blocks: KnownBlock[] = [
    header(heading),
    context(
      contextLine(
        longDate(view.date, options.timezone),
        view.matches.length,
        view.tournaments.length,
      ),
    ),
    divider(),
  ];

  if (view.matches.length === 0) {
    blocks.push(...awaitingTournaments(view.tournaments, options));
  } else {
    blocks.push(...dailyTournamentBlocks(view.matches, options));
  }

  return finish(blocks, {
    accent: ACCENTS.schedule,
    text: `Tennis TV: ${countSummary(view.matches.length, view.tournaments.length)} today`,
    navigation: NAVIGATION_ROWS.daily,
  });
}

/** One block per tournament: its name, then its timed matches, then its TBC count. */
function dailyTournamentBlocks(matches: readonly Match[], options: SummaryOptions): KnownBlock[] {
  const groups = [...groupByTournament(matches)];
  const shown = groups.slice(0, RENDER_LIMITS.dailyTournaments);
  const blocks: KnownBlock[] = [];

  for (const [tournamentName, group] of shown) {
    const timed = group.filter(hasKnownTime);
    const untimed = group.length - timed.length;
    const lines = [`*${escapeText(tournamentName)}*`];

    if (timed.length === 0) {
      // A tournament whose order of play is not out at all. One honest line beats a
      // wall of identical TBC rows.
      lines.push(`_${matchCount(group.length)} scheduled · times TBC_`);
    } else {
      const listed = timed.slice(0, RENDER_LIMITS.dailyMatchesPerTournament);
      lines.push(...listed.map((match) => matchLine(match, options.timezone)));

      const hidden = timed.length - listed.length;
      if (hidden > 0) lines.push(`_+ ${matchCount(hidden)} later_`);
      if (untimed > 0) lines.push(tbcSummary(untimed));
    }

    blocks.push(section(lines.join('\n')));
  }

  const remaining = groups.length - shown.length;
  if (remaining > 0) {
    blocks.push(context(`_+ ${tournamentCount(remaining)} — see the full week for detail._`));
  }

  return blocks;
}

// ------------------------------------------------------------------ weekly

export interface WeeklySummaryView {
  /** Inclusive local date range, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly matches: readonly Match[];
  readonly tournaments: readonly Tournament[];
}

/**
 * The week as an overview — one line per tournament per day, not one per match.
 *
 * ```
 * 🎾 Tennis TV — This Week
 * 28 Sep – 4 Oct · 4 tournaments · 72 matches
 * ─────────────
 * Mon 28 Sep
 * Beijing · 10:41–16:30
 * Tokyo · 04:00–TBC
 *
 * Wed 30 Sep
 * 18 matches · times TBC
 * ```
 *
 * A day's range is its first and last **start time**, which is real data. No end of
 * play is ever inferred, because Tennis TV does not publish one.
 */
export function buildWeeklySummary(view: WeeklySummaryView, options: SummaryOptions): BuiltMessage {
  const heading = '🎾 Tennis TV — This Week';
  const range = shortRange(view.from, view.to, options.timezone);

  const blocks: KnownBlock[] = [
    header(heading),
    context(contextLine(range, view.matches.length, view.tournaments.length)),
    divider(),
  ];

  const byDay = [...groupMatchesByDay(view.matches)].slice(0, RENDER_LIMITS.weeklyDays);

  if (byDay.length > 0) {
    let anyRange = false;

    for (const [date, matches] of byDay) {
      const lines = [`*${dayLabel(date, options.timezone)}*`];
      const groups = [...groupByTournament(matches)];
      const shown = groups.slice(0, RENDER_LIMITS.weeklyTournamentsPerDay);

      if (shown.every(([, group]) => !group.some(hasKnownTime))) {
        // Nothing on this day has a time yet: one line for the whole day.
        lines.push(`_${matchCount(matches.length)} · times TBC_`);
      } else {
        for (const [tournamentName, group] of shown) {
          const window = startWindow(group, options.timezone);
          if (window.isRange) anyRange = true;
          lines.push(`${escapeText(tournamentName)} · ${window.label}`);
        }

        const remaining = groups.length - shown.length;
        if (remaining > 0) lines.push(`_+ ${tournamentCount(remaining)}_`);
      }

      blocks.push(section(lines.join('\n')));
    }

    if (anyRange) {
      // Said once, so a reader does not mistake the right-hand time for an end of play.
      blocks.push(context('_Ranges show the first and last start time, not an end of play._'));
    }

    // Tournaments in the week with no order of play at all still matter: silence about
    // them reads as "nothing on".
    const covered = new Set(view.matches.map((match) => match.tournamentName));
    const awaiting = view.tournaments.filter((tournament) => !covered.has(tournament.name));
    if (awaiting.length > 0) {
      blocks.push(section('*Also this week*'));
      blocks.push(...tournamentLines(awaiting, options, RENDER_LIMITS.monthlyTournaments));
    }
  } else if (view.tournaments.length > 0) {
    blocks.push(...awaitingTournaments(view.tournaments, options));
  } else {
    // Weekly always posts, including when empty (PROJECT_SPEC.md §4.2).
    blocks.push(section('🎾 No Tennis TV matches are currently scheduled this week.'));
  }

  return finish(blocks, {
    accent: ACCENTS.schedule,
    text: `Tennis TV: weekly schedule for ${range}`,
    navigation: NAVIGATION_ROWS.weekly,
  });
}

/**
 * The span of published start times in a group.
 *
 * `10:41–16:30` when several are known, `from 10:41` when only one is, `10:41–TBC`
 * when some of the group has no time yet, and a plain count when none has.
 */
function startWindow(
  group: readonly Match[],
  timezone: string,
): { label: string; isRange: boolean } {
  const timed = group
    .filter(hasKnownTime)
    .slice()
    .sort(
      (a, b) => (a.schedule.startsAtUtc?.getTime() ?? 0) - (b.schedule.startsAtUtc?.getTime() ?? 0),
    );

  const earliest = timed.at(0);
  const latest = timed.at(-1);

  if (earliest === undefined || latest === undefined) {
    return { label: `_${matchCount(group.length)} · times TBC_`, isRange: false };
  }

  const first = timeLabel(earliest, timezone);

  // Some of the group has no time yet, so the right-hand end is genuinely unknown.
  if (timed.length < group.length) return { label: `${first}–TBC`, isRange: false };
  if (timed.length === 1) return { label: `from ${first}`, isRange: false };

  return { label: `${first}–${timeLabel(latest, timezone)}`, isRange: true };
}

// ----------------------------------------------------------------- monthly

export interface MonthlySummaryView {
  /** Inclusive local date range covering the month, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  readonly tournaments: readonly Tournament[];
  /** Usually empty: match data does not exist a month ahead. */
  readonly matches: readonly Match[];
}

/**
 * The month as a tournament schedule.
 *
 * ```
 * 🎾 Tennis TV — October 2026
 * 5 tournaments · 124 matches
 * ─────────────
 * Shanghai Masters
 * 1–12 Oct · 42 matches currently published
 *
 * Stockholm Open
 * 19–25 Oct · match times TBC
 * ```
 *
 * Deliberately not a list of matches: a month is several hundred, and reconnaissance
 * showed they are not published that far ahead anyway
 * (docs/TENNISTV_DATA_SOURCE.md §7).
 */
export function buildMonthlySummary(
  view: MonthlySummaryView,
  options: SummaryOptions,
): BuiltMessage {
  const month = monthName(view.from, options.timezone);
  const heading = `🎾 Tennis TV — ${month}`;

  const blocks: KnownBlock[] = [
    header(heading),
    context(contextLine('', view.matches.length, view.tournaments.length)),
    divider(),
  ];

  if (view.tournaments.length === 0) {
    // Monthly always posts, including when empty (PROJECT_SPEC.md §4.3).
    blocks.push(section('🎾 No Tennis TV matches are currently scheduled this month.'));
  } else {
    blocks.push(
      ...tournamentLines(view.tournaments, options, RENDER_LIMITS.monthlyTournaments, view.matches),
    );
  }

  return finish(blocks, {
    accent: ACCENTS.schedule,
    text: `Tennis TV: ${month} schedule — ${tournamentCount(view.tournaments.length)}`,
    navigation: NAVIGATION_ROWS.monthly,
  });
}

// ------------------------------------------------------------------ shared

/**
 * One block per tournament: name, then its window and what is published for it.
 *
 * Used by the monthly message and by the "also this week" tail of the weekly one.
 */
function tournamentLines(
  tournaments: readonly Tournament[],
  options: SummaryOptions,
  limit: number,
  matches: readonly Match[] = [],
): KnownBlock[] {
  const counts = countMatchesByTournament(matches);
  const sorted = [...tournaments].sort(byStartThenName);
  const shown = sorted.slice(0, limit);

  const blocks = shown.map((tournament) => {
    const count = counts.get(tournament.name) ?? 0;
    const detail = count > 0 ? `${matchCount(count)} currently published` : '_match times TBC_';

    return section(
      [
        `*${tournamentTitle(tournament)}*`,
        `${shortRange(tournament.startsOn, tournament.endsOn, options.timezone)} · ${detail}`,
      ].join('\n'),
    );
  });

  const remaining = sorted.length - shown.length;
  if (remaining > 0) blocks.push(context(`_+ ${tournamentCount(remaining)} this month._`));

  return blocks;
}

/** Tournaments that are running but whose order of play is not published yet. */
function awaitingTournaments(
  tournaments: readonly Tournament[],
  options: SummaryOptions,
): KnownBlock[] {
  if (tournaments.length === 0) {
    return [section('🎾 No Tennis TV matches are currently scheduled.')];
  }

  return [
    ...tournamentLines(tournaments, options, RENDER_LIMITS.dailyTournaments),
    context('_Match times are published closer to each tournament._'),
  ];
}

interface FinishOptions {
  readonly accent: (typeof ACCENTS)[keyof typeof ACCENTS];
  readonly text: string;
  readonly navigation: readonly NavigationButton[];
}

/**
 * Closes every summary the same way: a divider, the subscription row, then navigation.
 *
 * Two rows rather than one — five buttons side by side wrap badly on mobile, and the
 * two rows mean different things ("change what I get" versus "show me more").
 */
function finish(blocks: KnownBlock[], options: FinishOptions): BuiltMessage {
  const tail: KnownBlock[] = [
    divider(),
    subscriptionActions(),
    ...navigationActions(options.navigation),
  ];

  const capped = capBlocks(blocks, tail.length, '_…more not shown — open the full view._');

  return { blocks: [...capped, ...tail], text: fallback(options.text), accent: options.accent };
}

/** `18 matches · 4 tournaments`, omitting whichever is zero. */
function countSummary(matches: number, tournaments: number): string {
  const parts: string[] = [];
  if (matches > 0) parts.push(matchCount(matches));
  if (tournaments > 0) parts.push(tournamentCount(tournaments));
  // The notification preview is the whole message for anyone who does not open Slack.
  return parts.length === 0 ? 'nothing scheduled' : parts.join(' · ');
}

function groupByTournament(matches: readonly Match[]): Map<string, Match[]> {
  const groups = new Map<string, Match[]>();
  for (const match of matches) {
    const existing = groups.get(match.tournamentName);
    if (existing) existing.push(match);
    else groups.set(match.tournamentName, [match]);
  }
  return groups;
}

function groupMatchesByDay(matches: readonly Match[]): Map<string, Match[]> {
  const byDay = new Map<string, Match[]>();

  for (const match of matches) {
    const existing = byDay.get(match.schedule.onDate);
    if (existing) existing.push(match);
    else byDay.set(match.schedule.onDate, [match]);
  }

  return new Map([...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function countMatchesByTournament(matches: readonly Match[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.tournamentName, (counts.get(match.tournamentName) ?? 0) + 1);
  }
  return counts;
}

/** Linked when the provider gave a URL, plain otherwise. */
function tournamentTitle(tournament: Tournament): string {
  const name = escapeText(tournament.name);
  return tournament.sourceUrl === null ? name : `<${tournament.sourceUrl}|${name}>`;
}

const byStartThenName = (a: Tournament, b: Tournament): number =>
  a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name);

/** `Tue 29 Sep`. */
function longDate(isoDate: string, timezone: string): string {
  const parsed = DateTime.fromISO(isoDate, { zone: timezone });
  return parsed.isValid ? parsed.toFormat('ccc d LLL') : isoDate;
}

/** `Mon 28 Sep`, the weekly day heading. */
const dayLabel = longDate;

/** `October 2026`. */
function monthName(isoDate: string, timezone: string): string {
  const parsed = DateTime.fromISO(isoDate, { zone: timezone });
  return parsed.isValid ? parsed.toFormat('LLLL yyyy') : isoDate;
}

/** `23–29 Sep`, collapsing the month when both ends share it. */
function shortRange(fromIso: string, toIso: string, timezone: string): string {
  const from = DateTime.fromISO(fromIso, { zone: timezone });
  const to = DateTime.fromISO(toIso, { zone: timezone });

  if (!from.isValid || !to.isValid) return `${fromIso}–${toIso}`;
  if (from.hasSame(to, 'day')) return from.toFormat('d LLL');
  if (from.hasSame(to, 'month')) return `${from.toFormat('d')}–${to.toFormat('d LLL')}`;
  return `${from.toFormat('d LLL')} – ${to.toFormat('d LLL')}`;
}

export { timeLabel };
