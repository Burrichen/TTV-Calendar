/**
 * Block Kit for live, delayed and cancelled alerts (PROJECT_SPEC.md §6).
 *
 * These go to the configured channel, never a DM, and mention only the users currently
 * opted in. If nobody is opted in the caller must not post at all — that decision is
 * about state rather than presentation, so it lives with the caller, but these builders
 * refuse to render an alert with no recipients so the rule cannot be forgotten.
 */

import type { KnownBlock } from '@slack/types';

import { formatStartTime } from '../../domain/time.ts';
import type { Match, NotifiableTransition } from '../../domain/types.ts';
import {
  type BuiltMessage,
  context,
  escapeText,
  fallback,
  matchTitle,
  renderMentions,
  section,
} from './common.ts';
import { ACCENTS, type Accent } from './theme.ts';

export interface AlertOptions {
  readonly timezone: string;
}

export interface AlertView {
  readonly match: Match;
  /** Slack user IDs currently opted in. Must not be empty. */
  readonly subscriberIds: readonly string[];
  /** When the transition was observed, used for the "Started" line. */
  readonly observedAt: Date;
  /** The start time before a delay moved it. Null when it was never published. */
  readonly previousStartsAtUtc?: Date | null;
  /** The start time after a delay moved it. Null when Tennis TV gave no new time. */
  readonly newStartsAtUtc?: Date | null;
  /** The provider's own words, where it gave a reason. Never invented. */
  readonly reason?: string | null;
}

export class NoRecipientsError extends Error {
  override readonly name = 'NoRecipientsError';

  constructor(transition: NotifiableTransition) {
    super(
      `Refusing to build a ${transition} alert with no subscribers. ` +
        'PROJECT_SPEC.md §6.1: if nobody is opted in, post nothing at all.',
    );
  }
}

/**
 * ```
 * 🔴 LIVE
 * Sinner vs Alcaraz
 * Cincinnati Open
 * Started 19:04 UK
 *
 * 🔔 <@U123> <@U456>
 * ```
 *
 * The status leads on its own line so it is the first thing read, and the players are
 * the emphasised line beneath it — the two facts that decide whether anyone cares.
 */
export function buildLiveAlert(view: AlertView, options: AlertOptions): BuiltMessage {
  requireRecipients(view, 'LIVE');

  // A match can go live without a published start time, in which case the moment we
  // observed it is the only honest answer to "when did this start?".
  const started = formatStartTime(
    { ...view.match.schedule, startsAtUtc: view.match.schedule.startsAtUtc ?? view.observedAt },
    options.timezone,
  );

  return alertMessage(
    [
      '🔴 *LIVE*',
      `*${matchTitle(view.match)}*`,
      escapeText(view.match.tournamentName),
      `Started ${started} UK`,
    ],
    view,
    `🔴 LIVE — ${matchTitle(view.match)} (${escapeText(view.match.tournamentName)})`,
    ACCENTS.live,
  );
}

/**
 * ```
 * ⏸️ DELAYED — Player A vs Player B
 * ATP Example Open
 * Original start: 14:00 UK
 * New time: 15:00 UK
 *
 * <@U123> <@U456>
 * ```
 *
 * A delay is only ever reported because Tennis TV said so, or because it republished
 * the match at a later time — never because a scheduled start has passed
 * (PROJECT_SPEC.md §6.4). The "New time" line appears only when there genuinely is
 * one; the bot does not invent a replacement time it has not been given.
 */
export function buildDelayedAlert(view: AlertView, options: AlertOptions): BuiltMessage {
  requireRecipients(view, 'DELAYED');

  const lines = [
    '⏸️ *DELAYED*',
    `*${matchTitle(view.match)}*`,
    escapeText(view.match.tournamentName),
  ];

  const original = view.previousStartsAtUtc ?? view.match.schedule.startsAtUtc;
  if (original != null) {
    lines.push(`Original start: ${time(original, options)} UK`);
  }

  // Only when it differs — repeating the same time as a "new" one would be nonsense.
  const replacement = view.newStartsAtUtc;
  if (replacement != null && replacement.getTime() !== original?.getTime()) {
    lines.push(`New time: ${time(replacement, options)} UK`);
  }

  return alertMessage(
    lines,
    view,
    `⏸️ DELAYED — ${matchTitle(view.match)} (${escapeText(view.match.tournamentName)})`,
    ACCENTS.delayed,
  );
}

/**
 * ```
 * ❌ CANCELLED — Player A vs Player B
 * ATP Example Open
 *
 * <@U123> <@U456>
 * ```
 */
export function buildCancelledAlert(view: AlertView, _options: AlertOptions): BuiltMessage {
  // A cancellation states the fact and nothing else, so there is no time to render and
  // the options are unused — the parameter stays for a uniform builder signature.
  requireRecipients(view, 'CANCELLED');

  return alertMessage(
    ['❌ *CANCELLED*', `*${matchTitle(view.match)}*`, escapeText(view.match.tournamentName)],
    view,
    `❌ CANCELLED — ${matchTitle(view.match)} (${escapeText(view.match.tournamentName)})`,
    ACCENTS.cancelled,
  );
}

/** Dispatches to the right builder for a detected transition. */
export function buildAlert(
  transition: NotifiableTransition,
  view: AlertView,
  options: AlertOptions,
): BuiltMessage {
  switch (transition) {
    case 'LIVE':
      return buildLiveAlert(view, options);
    case 'DELAYED':
      return buildDelayedAlert(view, options);
    case 'CANCELLED':
      return buildCancelledAlert(view, options);
  }
}

/**
 * Four blocks at most, and usually three.
 *
 * An alert interrupts people, so it earns its space by being short: what happened, to
 * whom, and who is being told. No header block, no divider, no buttons — the coloured
 * bar already separates it from the schedules, and anyone reading it is mid-task.
 */
function alertMessage(
  lines: readonly string[],
  view: AlertView,
  fallbackText: string,
  accent: Accent,
): BuiltMessage {
  const blocks: KnownBlock[] = [section(lines.join('\n'))];

  // Round, court and the provider's reason go in small print, so the body of the
  // message stays exactly the shape the specification asks for.
  const detail = [courtAndRound(view.match), reasonText(view)].filter(
    (part): part is string => part !== null,
  );
  if (detail.length > 0) blocks.push(context(detail.join(' · ')));

  // Mentions in their own context block: quieter than a section, which stops a long
  // list of names competing with the headline. Only ever `<@U…>` from stored IDs —
  // never a group mention.
  blocks.push(context(`🔔 ${renderMentions(view.subscriberIds)}`));

  return { blocks, text: fallback(fallbackText), accent };
}

const time = (instant: Date, options: AlertOptions): string =>
  formatStartTime(
    { onDate: '', startsAtUtc: instant, notBeforeUtc: null, tbcReason: null },
    options.timezone,
  );

function courtAndRound(match: Match): string | null {
  const parts = [match.round, match.court].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length === 0 ? null : escapeText(parts.join(' · '));
}

function reasonText(view: AlertView): string | null {
  return typeof view.reason === 'string' && view.reason !== '' ? escapeText(view.reason) : null;
}

function requireRecipients(view: AlertView, transition: NotifiableTransition): void {
  if (view.subscriberIds.length === 0) throw new NoRecipientsError(transition);
}
