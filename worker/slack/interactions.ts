/**
 * Slack button interactions.
 *
 * Slack gives an interaction three seconds to be acknowledged, so this path is kept
 * deliberately short: verify, parse, one D1 upsert, reply. The confirmation is returned
 * as the HTTP response body rather than posted through `chat.postEphemeral`, which
 * removes a whole network round trip from the budget — Slack renders a `response_type:
 * ephemeral` body as a private reply in the channel where the click happened.
 *
 * Nothing is done before verification succeeds. An unverified request is not parsed,
 * not logged in full, and never reaches D1.
 */

import type { Logger } from '../../src/logging/types.ts';
import {
  buildErrorResponse,
  buildSubscriptionConfirmation,
} from '../../src/slack/blocks/diagnostics.ts';
import { PAGE_ACTION_IDS } from '../../src/slack/blocks/calendar-views.ts';
import { SUBSCRIPTION_ACTION_IDS } from '../../src/slack/blocks/subscription.ts';
import { optIn, optOut } from '../d1/subscriptions.ts';
import { isCalendarAction, openCalendarView, pageCalendarView } from './calendar.ts';
import type { SlackViews } from './views.ts';

/** Only the fields we use. Slack sends a great deal more, none of it needed here. */
interface BlockActionsPayload {
  readonly type?: string;
  readonly team?: { readonly id?: string } | null;
  readonly user?: { readonly id?: string } | null;
  readonly channel?: { readonly id?: string } | null;
  /** Expires within seconds; required to open a modal. */
  readonly trigger_id?: string;
  /** Present when the click came from inside an open modal. */
  readonly view?: {
    readonly id?: string;
    readonly private_metadata?: string;
  } | null;
  readonly actions?: readonly { readonly action_id?: string; readonly value?: string }[] | null;
}

export interface InteractionOptions {
  readonly db: D1Database;
  readonly logger: Logger;
  /** Used when a payload arrives without a channel, which Slack allows. */
  readonly fallbackChannelId: string;
  readonly now: Date;
  /** Opens and updates calendar modals. Null when no bot token is configured. */
  readonly views?: SlackViews | null;
  readonly timezone?: string;
}

/**
 * Applies a verified interaction and returns the body to send back to Slack.
 *
 * Returns a `Response` for every outcome, including failure: an unhandled rejection
 * here would leave the user with a silent, un-acknowledged click.
 */
export async function handleInteraction(
  rawBody: string,
  options: InteractionOptions,
): Promise<Response> {
  const payload = parsePayload(rawBody);

  if (payload === null) {
    options.logger.warn('interaction payload could not be parsed');
    return ephemeral(buildErrorResponse("Sorry — I couldn't read that interaction."));
  }

  if (payload.type !== 'block_actions') {
    // Not an error: Slack sends other interaction types to the same URL. Acknowledge
    // and do nothing, rather than replying to something we were not asked about.
    options.logger.debug({ type: payload.type ?? 'none' }, 'ignoring non-button interaction');
    return new Response('', { status: 200 });
  }

  const action = payload.actions?.[0];
  const actionId = action?.action_id;
  const userId = payload.user?.id;

  if (typeof userId !== 'string' || userId === '') {
    options.logger.warn('button click carried no user id; ignoring');
    return new Response('', { status: 200 });
  }

  // --- calendar navigation -------------------------------------------------
  // Handled before the subscription branch, and acknowledged with an empty 200: the
  // modal is the response, so replying with a message here would put a stray line in
  // the channel on top of it.
  const calendar = {
    db: options.db,
    views: options.views ?? null,
    logger: options.logger,
    timezone: options.timezone ?? 'Europe/London',
    now: options.now,
  };

  if (typeof actionId === 'string' && isCalendarAction(actionId)) {
    const triggerId = payload.trigger_id;

    if (typeof triggerId !== 'string' || triggerId === '') {
      options.logger.warn({ actionId }, 'calendar click carried no trigger_id; ignoring');
      return new Response('', { status: 200 });
    }

    // A click from a 🧪 TEST message carries "TEST" and opens the drill's calendar, so
    // a simulation can demonstrate the whole flow without touching real snapshots.
    const variant = action?.value === 'TEST' ? 'TEST' : 'LIVE';

    await openCalendarView(calendar, actionId, triggerId, variant);
    return new Response('', { status: 200 });
  }

  if (actionId === PAGE_ACTION_IDS.previous || actionId === PAGE_ACTION_IDS.next) {
    const viewId = payload.view?.id;
    const metadata = payload.view?.private_metadata;
    const requestedPage = Number(action?.value);

    if (
      typeof viewId !== 'string' ||
      typeof metadata !== 'string' ||
      !Number.isInteger(requestedPage)
    ) {
      options.logger.warn({ actionId }, 'calendar page click was incomplete; ignoring');
      return new Response('', { status: 200 });
    }

    await pageCalendarView(calendar, viewId, metadata, requestedPage);
    return new Response('', { status: 200 });
  }

  const desiredActive =
    actionId === SUBSCRIPTION_ACTION_IDS.optIn
      ? true
      : actionId === SUBSCRIPTION_ACTION_IDS.optOut
        ? false
        : null;

  if (desiredActive === null) {
    options.logger.debug({ actionId: actionId ?? 'none' }, 'ignoring unrecognised action');
    return new Response('', { status: 200 });
  }

  const ref = {
    teamId: payload.team?.id ?? 'unknown',
    channelId: payload.channel?.id ?? options.fallbackChannelId,
    userId,
  };

  try {
    // A click means "set my subscription to X", never "toggle". That is what keeps a
    // button on a summary posted weeks ago doing exactly what its label says.
    const result = desiredActive
      ? await optIn(options.db, ref, options.now)
      : await optOut(options.db, ref, options.now);

    options.logger.info(
      {
        userId: ref.userId,
        channelId: ref.channelId,
        enabled: result.enabled,
        changed: result.changed,
      },
      'subscription updated',
    );

    return ephemeral(buildSubscriptionConfirmation(result.enabled, result.changed));
  } catch (error) {
    // D1 unavailable, most likely. Tell the user privately; never leave the click
    // looking as though it succeeded.
    options.logger.error({ err: error, userId: ref.userId }, 'subscription click failed');
    return ephemeral(
      buildErrorResponse("Sorry — I couldn't update your alert preference. Please try again."),
    );
  }
}

/**
 * Slack posts interactions as `application/x-www-form-urlencoded` with the JSON in a
 * `payload` field — not as a JSON body, which is the usual first assumption.
 */
function parsePayload(rawBody: string): BlockActionsPayload | null {
  try {
    const encoded = new URLSearchParams(rawBody).get('payload');
    if (encoded === null) return null;
    return JSON.parse(encoded) as BlockActionsPayload;
  } catch {
    return null;
  }
}

const ephemeral = (message: { blocks: unknown; text: string }): Response =>
  new Response(
    JSON.stringify({
      response_type: 'ephemeral',
      replace_original: false,
      text: message.text,
      blocks: message.blocks,
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
