/**
 * The "show me more" buttons.
 *
 * Public messages are summaries, so each one ends with a way to reach the detail it
 * deliberately left out. The action IDs are a stable contract — a button on a summary
 * posted weeks ago must still mean the same thing — and follow the same `ttv_` prefix
 * as the subscription actions.
 *
 * These are **not wired up yet**. The Worker acknowledges an unrecognised action with
 * a 200 and does nothing, so clicking one is inert rather than an error; the views
 * behind them arrive separately.
 */

import type { KnownBlock } from '@slack/types';

export const NAVIGATION_ACTION_IDS = {
  /** From the daily message: the week around today. */
  viewWeek: 'ttv_calendar_view_week',
  /** From daily and weekly: the month. */
  viewMonth: 'ttv_calendar_view_month',
  /** From the weekly message: every match in the week, not just the overview. */
  viewFullWeek: 'ttv_calendar_view_full_week',
  /** From the monthly message: the month in full. */
  viewFullMonth: 'ttv_calendar_view_full_month',
} as const;

export type NavigationActionId = (typeof NAVIGATION_ACTION_IDS)[keyof typeof NAVIGATION_ACTION_IDS];

/** The block containing them, so tests and handlers agree on where to look. */
export const NAVIGATION_BLOCK_ID = 'ttv_calendar_navigation';

export interface NavigationButton {
  readonly actionId: NavigationActionId;
  readonly label: string;
}

type ActionsBlock = Extract<KnownBlock, { type: 'actions' }>;
type ActionElement = ActionsBlock['elements'][number];

/**
 * Which calendar a button opens: the real one, or a drill's.
 *
 * Carried in the button's `value` because the click payload has no other way to say
 * which message it came from. Not a security boundary — the request is still signature
 * verified, and the worst a forged value achieves is showing the test calendar, which
 * holds nothing sensitive.
 */
export const LIVE_VARIANT = 'LIVE';
export const TEST_VARIANT = 'TEST';

const button = ({ actionId, label }: NavigationButton): ActionElement => ({
  type: 'button',
  action_id: actionId,
  text: { type: 'plain_text', text: label, emoji: true },
  // Never anything time-dependent: a button rendered weeks ago must still mean what
  // its label says.
  value: LIVE_VARIANT,
});

/** A row of navigation buttons, or nothing when there are none to show. */
export function navigationActions(buttons: readonly NavigationButton[]): KnownBlock[] {
  if (buttons.length === 0) return [];

  const row: ActionsBlock = {
    type: 'actions',
    block_id: NAVIGATION_BLOCK_ID,
    elements: buttons.map(button),
  };

  return [row];
}

/** The rows each summary carries, named so the call sites read as the design does. */
export const NAVIGATION_ROWS = {
  daily: [
    { actionId: NAVIGATION_ACTION_IDS.viewWeek, label: '📅 View week' },
    { actionId: NAVIGATION_ACTION_IDS.viewMonth, label: '🗓 View month' },
  ],
  weekly: [
    { actionId: NAVIGATION_ACTION_IDS.viewFullWeek, label: '📋 Full week' },
    { actionId: NAVIGATION_ACTION_IDS.viewMonth, label: '🗓 View month' },
  ],
  monthly: [{ actionId: NAVIGATION_ACTION_IDS.viewFullMonth, label: '🗓 View full month' }],
} as const satisfies Record<string, readonly NavigationButton[]>;
