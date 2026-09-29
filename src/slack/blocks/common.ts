/**
 * Shared Block Kit helpers.
 *
 * Everything here is a pure function over view models, which is what lets the message
 * shapes be asserted exhaustively without a Slack workspace (ARCHITECTURE.md §6).
 */

import type { AnyBlock, KnownBlock } from '@slack/types';

import { TIME_TBC, formatStartTime } from '../../domain/time.ts';
import type { Match } from '../../domain/types.ts';
import type { Accent } from './theme.ts';

/**
 * A finished message, ready to post.
 *
 * `blocks` render inside a single coloured attachment; `text` is the concise plain
 * summary used for notifications and by anything that cannot render blocks. Both are
 * always present — colour and layout are never the only carriers of meaning.
 */
export interface BuiltMessage {
  readonly blocks: KnownBlock[];
  /** Plain-text notification fallback. One line, useful on its own. */
  readonly text: string;
  /** The attachment's left-hand accent bar. */
  readonly accent?: Accent;
}

/** Slack's hard limits. Exceeding any of them is a 400, so the builders respect them. */
export const SLACK_LIMITS = {
  /** Blocks per message. */
  maxBlocks: 50,
  /** Characters in a section's text. */
  maxSectionText: 3000,
  /** Characters in a context element. */
  maxContextText: 3000,
  /** Characters in the notification fallback. */
  maxFallbackText: 3000,
} as const;

/**
 * How much a public summary is allowed to show.
 *
 * These are editorial limits, not technical ones — Slack would accept more. A public
 * message answers "is there tennis I can test against?", and a reader who has to scroll
 * has already been failed. Everything beyond a limit is **aggregated, never silently
 * dropped**: the count is always stated, and the detail lives behind the view buttons.
 *
 * They also make the message size independent of how large a day Tennis TV happens to
 * have, which is what stops an unusually busy Monday producing an unpostable message.
 */
export const RENDER_LIMITS = {
  /** Tournaments listed individually in the daily message. */
  dailyTournaments: 6,
  /** Timed matches listed per tournament in the daily message. */
  dailyMatchesPerTournament: 6,
  /** Days listed in the weekly overview. A week has seven; this is a safety net. */
  weeklyDays: 7,
  /** Tournaments listed per day in the weekly overview. */
  weeklyTournamentsPerDay: 5,
  /** Tournaments listed individually in the monthly message. */
  monthlyTournaments: 10,
} as const;

/**
 * Mass-mention tokens the bot must never send (PROJECT_SPEC.md §6.1).
 *
 * Checked here and enforced again in the message service. Two layers because a builder
 * bug and a caller bug are different mistakes, and neither should reach the channel.
 */
export const BANNED_MENTIONS = ['@channel', '@here', '@everyone'] as const;

export const containsBannedMention = (text: string): boolean =>
  BANNED_MENTIONS.some((token) => text.includes(token));

export const section = (text: string): KnownBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(text, SLACK_LIMITS.maxSectionText) },
});

export const context = (text: string): KnownBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: truncate(text, SLACK_LIMITS.maxContextText) }],
});

export const header = (text: string): KnownBlock => ({
  type: 'header',
  // Header text is plain: Slack ignores markdown here, and emoji still render.
  text: { type: 'plain_text', text: truncate(text, 150), emoji: true },
});

export const divider = (): KnownBlock => ({ type: 'divider' });

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Escapes the three characters Slack treats specially in message text.
 *
 * Player and tournament names come from an external source, so they are never
 * interpolated raw — a name containing `<` would otherwise be read as markup.
 */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `<@U123>` mentions, from stored subscriber IDs only. Never a group mention. */
export function renderMentions(userIds: readonly string[]): string {
  return userIds.map((id) => `<@${id}>`).join(' ');
}

/** `Sinner vs Alcaraz`, with an undecided side shown honestly rather than blank. */
export function matchTitle(match: Match): string {
  return `${escapeText(match.sideOne.name)} vs ${escapeText(match.sideTwo.name)}`;
}

/**
 * The leading time label: `11:00` or `TBC`.
 *
 * `TBC` is never a guess dressed up — it means Tennis TV has not published a start
 * time (PROJECT_SPEC.md §8).
 */
export function timeLabel(match: Match, timezone: string): string {
  const formatted = formatStartTime(match.schedule, timezone);
  return formatted === TIME_TBC ? 'TBC' : formatted;
}

/** `*11:00* — Player A vs Player B`, the compact scannable line. */
export function matchLine(match: Match, timezone: string): string {
  return `*${timeLabel(match, timezone)}* — ${matchTitle(match)}`;
}

/** Whether Tennis TV has published a start time for this match. */
export const hasKnownTime = (match: Match): boolean => match.schedule.startsAtUtc !== null;

/** `1 match` / `4 matches`. Used everywhere a count is stated, so it reads the same. */
export const matchCount = (count: number): string =>
  `${String(count)} match${count === 1 ? '' : 'es'}`;

/** `1 tournament` / `4 tournaments`. */
export const tournamentCount = (count: number): string =>
  `${String(count)} tournament${count === 1 ? '' : 's'}`;

/**
 * The line that stands in for matches whose time is not published yet.
 *
 * Never omitted when there are any: hiding the existence of scheduled tennis is worse
 * than a slightly longer message (PROJECT_SPEC.md §8).
 */
export const tbcSummary = (count: number): string => `_+ ${matchCount(count)} — time TBC_`;

/**
 * Keeps a message inside Slack's block limit, replacing the overflow with a count.
 *
 * A truncated message that says so is useful; a message Slack refuses to render is
 * not. The reserve leaves room for whatever the caller appends afterwards (the
 * subscription buttons, a footer).
 */
export function capBlocks(blocks: KnownBlock[], reserve: number, moreLabel: string): KnownBlock[] {
  const budget = SLACK_LIMITS.maxBlocks - reserve;
  if (blocks.length <= budget) return blocks;

  // One block of the budget is spent saying what was left out.
  const kept = blocks.slice(0, Math.max(0, budget - 1));
  return [...kept, context(moreLabel)];
}

/** Plain-text fallback for notifications and accessibility. */
export function fallback(text: string): string {
  return truncate(text, SLACK_LIMITS.maxFallbackText);
}

/** Flattens a block's user-visible text, for the safety checks and for tests. */
export function blockText(blocks: readonly AnyBlock[]): string {
  const parts: string[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };

  visit(blocks);
  return parts.join('\n');
}
