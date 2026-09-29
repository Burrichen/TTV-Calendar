/**
 * The calendar buttons: opening a modal, and paging within it.
 *
 * Everything here happens inside Slack's three-second interaction deadline, so the path
 * is deliberately short: read one row from D1, render it, call Slack once, return 200.
 * **No Tennis TV request is ever made here** — the Worker does not know how, by design
 * (docs/ARCHITECTURE.md §15). If no snapshot exists, that is a view saying so, not a
 * fallback fetch.
 *
 * Which period a button means is derived from the clock, not from the payload. The
 * incoming `private_metadata` is validated and used only for the page number and the
 * snapshot it belongs to; everything it claims is re-read from D1.
 */

import { DateTime } from 'luxon';
import { z } from 'zod';
import type { ModalView } from '@slack/types';

import {
  monthSnapshotKey,
  weekSnapshotKey,
  type SnapshotVariant,
} from '../../src/domain/snapshot.ts';
import {
  buildMonthView,
  buildUnavailableView,
  buildWeekView,
} from '../../src/slack/blocks/calendar-views.ts';
import { NAVIGATION_ACTION_IDS } from '../../src/slack/blocks/navigation.ts';
import type { Logger } from '../../src/logging/types.ts';
import { loadSnapshot } from '../d1/snapshots.ts';
import { SlackViewError, type SlackViews } from './views.ts';

/** Which calendar a button opens. */
const BUTTON_PERIODS: Record<string, 'WEEK' | 'MONTH'> = {
  [NAVIGATION_ACTION_IDS.viewWeek]: 'WEEK',
  [NAVIGATION_ACTION_IDS.viewFullWeek]: 'WEEK',
  [NAVIGATION_ACTION_IDS.viewMonth]: 'MONTH',
  [NAVIGATION_ACTION_IDS.viewFullMonth]: 'MONTH',
};

export const isCalendarAction = (actionId: string): boolean => actionId in BUTTON_PERIODS;

/**
 * The state a modal carries between pages.
 *
 * Validated rather than trusted: it arrives from the client and could say anything.
 * Nothing secret goes in here — it only names which page of which snapshot to show, and
 * the snapshot itself is re-read from D1 every time.
 */
const metadataSchema = z.object({
  periodKey: z.string().min(1).max(64),
  variant: z.enum(['LIVE', 'TEST']),
  page: z.number().int().min(0).max(100),
});

export interface CalendarRequest {
  readonly db: D1Database;
  readonly views: SlackViews | null;
  readonly logger: Logger;
  readonly timezone: string;
  readonly now: Date;
}

/** Opens the week or month view for a button click. */
export async function openCalendarView(
  request: CalendarRequest,
  actionId: string,
  triggerId: string,
  variant: SnapshotVariant,
): Promise<void> {
  const period = BUTTON_PERIODS[actionId];
  if (period === undefined) return;

  const periodKey =
    period === 'WEEK'
      ? currentWeekKey(request.now, request.timezone)
      : currentMonthKey(request.now, request.timezone);

  const view = await render(request, periodKey, period, variant, 0);
  await present(request, (views) => views.open(triggerId, view), 'views.open');
}

/** Re-renders an open modal on a different page. */
export async function pageCalendarView(
  request: CalendarRequest,
  viewId: string,
  rawMetadata: string,
  requestedPage: number,
): Promise<void> {
  const parsed = parseMetadata(rawMetadata);
  if (parsed === null) {
    request.logger.warn('calendar page click carried unusable metadata; ignoring');
    return;
  }

  const period = parsed.periodKey.startsWith('week:') ? 'WEEK' : 'MONTH';
  const view = await render(request, parsed.periodKey, period, parsed.variant, requestedPage);

  await present(request, (views) => views.update(viewId, view), 'views.update');
}

/** Builds the view for a period, or the "unavailable" one when nothing is stored. */
async function render(
  request: CalendarRequest,
  periodKey: string,
  period: 'WEEK' | 'MONTH',
  variant: SnapshotVariant,
  page: number,
): Promise<ModalView> {
  const stored = await loadSnapshot(request.db, periodKey, variant);

  if (stored === null) {
    request.logger.info({ periodKey, variant }, 'no calendar snapshot available');
    return buildUnavailableView({
      period: period === 'WEEK' ? 'week' : 'month',
      timezone: request.timezone,
    });
  }

  const options = {
    page,
    test: variant === 'TEST',
    now: request.now,
  };

  return period === 'WEEK'
    ? buildWeekView(stored.snapshot, options)
    : buildMonthView(stored.snapshot, options);
}

/**
 * Calls Slack, turning a failure into a log line rather than an exception.
 *
 * A failed `views.open` must not stop the handler returning 200: Slack retries an
 * un-acknowledged interaction, which would open the same modal twice.
 */
async function present(
  request: CalendarRequest,
  call: (views: SlackViews) => Promise<void>,
  what: string,
): Promise<void> {
  if (request.views === null) {
    request.logger.warn(
      'calendar button clicked but SLACK_BOT_TOKEN is not set on the Worker; no view opened',
    );
    return;
  }

  try {
    await call(request.views);
  } catch (error) {
    request.logger.error(
      { code: error instanceof SlackViewError ? error.code : 'unknown', what },
      'could not present the calendar view',
    );
  }
}

function parseMetadata(raw: string): z.infer<typeof metadataSchema> | null {
  try {
    const result = metadataSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The ISO week containing `now`, in the configured zone. */
function currentWeekKey(now: Date, timezone: string): string {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  return weekSnapshotKey(local.weekYear, local.weekNumber);
}

function currentMonthKey(now: Date, timezone: string): string {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  return monthSnapshotKey(local.year, local.month);
}
