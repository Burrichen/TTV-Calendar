/**
 * The opt-in / opt-out buttons carried by every scheduled summary
 * (PROJECT_SPEC.md §5).
 *
 * The action IDs are a contract between these blocks and `slack/actions.ts`, and they
 * are stable: buttons on a summary posted weeks ago must keep working, because a click
 * means "set my subscription to X" and never anything relative to the message.
 */

import type { KnownBlock } from '@slack/types';

export const SUBSCRIPTION_ACTION_IDS = {
  optIn: 'ttv_subscription_opt_in',
  optOut: 'ttv_subscription_opt_out',
} as const;

/** The block containing them, so tests and handlers agree on where to look. */
export const SUBSCRIPTION_BLOCK_ID = 'ttv_subscription_actions';

export function subscriptionActions(): KnownBlock {
  return {
    type: 'actions',
    block_id: SUBSCRIPTION_BLOCK_ID,
    elements: [
      {
        type: 'button',
        action_id: SUBSCRIPTION_ACTION_IDS.optIn,
        text: { type: 'plain_text', text: '🔔 Opt in to live alerts', emoji: true },
        // No `style: primary` — nothing here is destructive or default, and two
        // coloured buttons side by side read as a choice the user must make now.
        value: 'opt_in',
      },
      {
        type: 'button',
        action_id: SUBSCRIPTION_ACTION_IDS.optOut,
        text: { type: 'plain_text', text: '🔕 Opt out of live alerts', emoji: true },
        value: 'opt_out',
      },
    ],
  };
}
