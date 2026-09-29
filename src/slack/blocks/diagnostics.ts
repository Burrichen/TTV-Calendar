/**
 * Ephemeral replies: subscription confirmations and errors.
 *
 * Everything here is shown to one person and never posted to the channel. A confused
 * or failed interaction must not become a public message (PROJECT_SPEC.md §5).
 *
 * Returned as the body of the Worker's HTTP response to the button click, which is why
 * there is no Slack client involved and no second round trip.
 */

import type { KnownBlock } from '@slack/types';

import { context, escapeText, fallback, section, truncate } from './common.ts';
import type { BuiltMessage } from './summaries.ts';

/**
 * Confirms an opt-in or opt-out.
 *
 * `changed` distinguishes "you are now opted in" from "you were already opted in", so
 * a repeat click gets an honest answer rather than pretending something happened.
 * Either way it is a success, never an error (PROJECT_SPEC.md §5).
 */
export function buildSubscriptionConfirmation(isActive: boolean, changed: boolean): BuiltMessage {
  const text = isActive
    ? changed
      ? "✅ You're opted in to Tennis TV live alerts.\n\nYou'll be @mentioned here when a match starts, is delayed or is cancelled."
      : "✅ You're already opted in to Tennis TV live alerts — nothing changed."
    : changed
      ? "🔕 You've opted out of Tennis TV live alerts.\n\nYou'll no longer be @mentioned. Scheduled summaries still post to this channel."
      : "🔕 You're already opted out of Tennis TV live alerts — nothing changed.";

  return { blocks: [section(text)], text: fallback(text) };
}

/** A failure during an interaction, shown only to the person who clicked. */
export function buildErrorResponse(summary: string, detail?: string): BuiltMessage {
  const blocks: KnownBlock[] = [section(`⚠️ ${escapeText(summary)}`)];

  if (detail !== undefined && detail !== '') {
    // Truncated hard: an ephemeral reply is not the place for a stack trace, and the
    // full error is already in the structured logs.
    blocks.push(context(`\`${escapeText(truncate(detail, 300))}\``));
  }

  return { blocks, text: fallback(`⚠️ ${summary}`) };
}
