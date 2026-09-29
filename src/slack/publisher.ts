/**
 * The only module that posts to the channel.
 *
 * Concentrating every send here is what makes the safety rules in PROJECT_SPEC.md §6.1
 * enforceable rather than merely intended:
 *
 *  - the destination channel is read from configuration, never passed by a caller, so
 *    no code path can post an alert anywhere else or DM anyone;
 *  - `@channel` / `@here` / `@everyone` cause a thrown error, not a silent strip, so a
 *    formatting bug fails in tests instead of pinging a workspace;
 *  - duplicate suppression is claimed in the state API before the post, so a crashed
 *    run loses a message rather than duplicating one (docs/ARCHITECTURE.md §8);
 *  - `SLACK_DRY_RUN` short-circuits delivery while exercising everything else.
 *
 * The claim → send → settle ordering is deliberate. A crash between claim and send
 * leaves an unsettled claim, which a later run can retry safely; the reverse ordering
 * would risk a duplicate, and nobody can un-send one.
 */

import type { AnyBlock, KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';

import type { Logger } from '../logging/types.ts';
import type { NotificationKind, StateApi } from '../state/client.ts';
import { BANNED_MENTIONS, blockText } from './blocks/common.ts';
import { markAsSimulation } from './blocks/simulation.ts';
import { ACCENTS, type Accent } from './blocks/theme.ts';

/** Thrown when a payload would mass-mention the channel. Never caught and ignored. */
export class BannedMentionError extends Error {
  override readonly name = 'BannedMentionError';

  constructor(token: string) {
    super(
      `Refusing to send a message containing "${token}". ` +
        'PROJECT_SPEC.md §6.1 forbids @channel, @here and @everyone.',
    );
  }
}

/** Marks our messages in the channel so a retry can recognise its own earlier send. */
export const METADATA_EVENT_TYPE = 'ttv_calendar_message';

/** How many recent messages to search when resolving an ambiguous retry. */
const HISTORY_LOOKBACK = 100;

export interface PublishRequest {
  /** Identifies the message by meaning, so a retry or re-run cannot duplicate it. */
  readonly key: string;
  readonly kind: NotificationKind;
  readonly reference: string;
  readonly blocks: readonly KnownBlock[];
  /** Plain-text notification fallback. */
  readonly text: string;
  /** The attachment's accent bar. Defaults to the schedule green. */
  readonly accent?: Accent;
  readonly recipientCount?: number;
  /** Adds the 🧪 TEST banner. Applied here so no call site can forget it. */
  readonly simulated?: boolean;
}

export type PublishOutcome =
  | { readonly status: 'sent'; readonly ts: string | null }
  | { readonly status: 'duplicate'; readonly reason: string }
  | { readonly status: 'dry-run' }
  | { readonly status: 'failed'; readonly error: unknown };

export interface PublisherOptions {
  readonly client: WebClient;
  readonly state: StateApi;
  readonly logger: Logger;
  /** The one channel this bot speaks in. */
  readonly channelId: string;
  readonly dryRun: boolean;
}

export class SlackPublisher {
  readonly #client: WebClient;
  readonly #state: StateApi;
  readonly #logger: Logger;
  readonly #channelId: string;
  readonly #dryRun: boolean;

  constructor(options: PublisherOptions) {
    this.#client = options.client;
    this.#state = options.state;
    this.#logger = options.logger.child({ component: 'slack-publisher' });
    this.#channelId = options.channelId;
    this.#dryRun = options.dryRun;
  }

  /** The channel every message goes to. Exposed for logging, not for routing. */
  get channelId(): string {
    return this.#channelId;
  }

  /**
   * Posts once, ever, for a given key.
   *
   * Never throws for an expected outcome — a duplicate and a Slack failure are both
   * returned, so one failed alert cannot abort a run that still has other work. A
   * failure of the *state API* does throw: without it there is no duplicate protection,
   * and posting blind is worse than not posting.
   */
  async publish(request: PublishRequest, now: Date): Promise<PublishOutcome> {
    // Schedules are green unless the caller says otherwise; alerts pass their own.
    const accent: Accent = request.accent ?? ACCENTS.schedule;
    const base = { blocks: [...request.blocks], text: request.text, accent };
    const payload = request.simulated === true ? markAsSimulation(base) : base;

    // Before the claim, so a banned mention is a loud programming error rather than a
    // consumed idempotency key.
    assertNoBannedMentions(payload.blocks, payload.text);

    const claim = await this.#state.claim({
      key: request.key,
      kind: request.kind,
      reference: request.reference,
      now,
    });

    if (claim.status === 'duplicate') {
      this.#logger.debug(
        { key: request.key, reason: claim.reason },
        'already handled; not posting',
      );
      return { status: 'duplicate', reason: claim.reason };
    }

    if (this.#dryRun) {
      await this.#state.settle({
        key: request.key,
        outcome: 'suppressed',
        now,
        reason: 'SLACK_DRY_RUN',
      });
      this.#logger.info({ key: request.key, text: payload.text }, 'dry run: message not sent');
      return { status: 'dry-run' };
    }

    // A retry means an earlier attempt failed *somewhere* — possibly after Slack had
    // already accepted the message. Ask the channel before sending it again.
    if (claim.attempts > 1) {
      const existingTs = await this.#findDelivered(request.key);
      if (existingTs !== null) {
        await this.#state.settle({
          key: request.key,
          outcome: 'sent',
          now,
          slackTs: existingTs,
        });
        this.#logger.info(
          { key: request.key, ts: existingTs },
          'earlier attempt had in fact landed; not re-posting',
        );
        return { status: 'duplicate', reason: 'found-in-channel' };
      }
    }

    try {
      const response = await this.#client.chat.postMessage({
        channel: this.#channelId,
        // A single attachment, purely so Slack draws the coloured bar down the left —
        // top-level blocks cannot be coloured. The blocks inside are ordinary Block
        // Kit; this is not the legacy attachment format.
        //
        // `text` is deliberately NOT set at the top level. Slack renders a top-level
        // `text` as a line ABOVE the attachment, which would print the summary twice.
        // The attachment's `fallback` is what notifications and plain-text clients
        // read, so the concise summary still reaches both.
        attachments: [
          {
            color: accent,
            fallback: payload.text,
            blocks: payload.blocks,
          },
        ],
        // Never let Slack expand a link into a card; these messages are dense already.
        unfurl_links: false,
        unfurl_media: false,
        metadata: {
          event_type: METADATA_EVENT_TYPE,
          event_payload: { idempotency_key: request.key },
        },
      });

      const ts = typeof response.ts === 'string' ? response.ts : null;
      await this.#state.settle({
        key: request.key,
        outcome: 'sent',
        now,
        slackTs: ts,
        recipientCount: request.recipientCount ?? null,
      });

      this.#logger.info({ key: request.key, ts }, 'message posted');
      return { status: 'sent', ts };
    } catch (error) {
      // The claim stays PENDING, so a later run retries once it goes stale.
      //
      // Recording the failure must not itself throw and mask the original problem —
      // and note this is a `try`, not a trailing `.catch()`: if the state API is the
      // thing that is down, the call can fail *synchronously*, which `.catch()` would
      // not intercept.
      try {
        await this.#state.settle({
          key: request.key,
          outcome: 'failed',
          now,
          reason: describe(error),
        });
      } catch (nested) {
        this.#logger.error({ err: nested }, 'could not record the delivery failure');
      }

      this.#logger.error(
        { err: error, key: request.key },
        'failed to post message; claim left pending for a later run',
      );

      return { status: 'failed', error };
    }
  }

  /**
   * Looks for a message this bot already posted carrying `key`.
   *
   * Returns null both when it is genuinely absent and when the channel could not be
   * read. That is the conservative direction for a *retry* path: the alternative is
   * suppressing a message that was never sent.
   */
  async #findDelivered(key: string): Promise<string | null> {
    try {
      const history = await this.#client.conversations.history({
        channel: this.#channelId,
        limit: HISTORY_LOOKBACK,
        include_all_metadata: true,
      });

      for (const message of history.messages ?? []) {
        const payload = message.metadata?.event_payload as
          { idempotency_key?: unknown } | undefined;
        if (payload?.idempotency_key === key && typeof message.ts === 'string') return message.ts;
      }
    } catch (error) {
      this.#logger.warn(
        { err: error },
        'could not read channel history to check for an earlier delivery',
      );
    }

    return null;
  }
}

/** Scans the rendered text of a payload for mass-mention tokens. */
export function assertNoBannedMentions(blocks: readonly AnyBlock[], text: string): void {
  const rendered = `${blockText(blocks)}\n${text}`;
  for (const token of BANNED_MENTIONS) {
    if (rendered.includes(token)) throw new BannedMentionError(token);
  }
}

/** A short, safe description of a failure. Never the whole object. */
const describe = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
