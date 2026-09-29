/**
 * A stand-in for Slack's WebClient.
 *
 * A fake rather than a mock: it records what would have been sent so tests can assert
 * on the resulting messages, which is what actually matters, rather than on which
 * methods were called.
 */

import type { AnyBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';

/**
 * A post as the publisher actually sends it.
 *
 * Messages go out as a single coloured attachment, so `blocks` and `text` are read back
 * out of it — `text` from the attachment's `fallback`, which is what Slack shows in a
 * notification. Tests assert on those rather than on the attachment shape, because the
 * rendered message is what matters; `accent` is exposed separately for the tests that
 * are specifically about colour.
 */
export interface RecordedPost {
  readonly channel: string;
  readonly text: string;
  readonly blocks: AnyBlock[];
  readonly accent: string | undefined;
  readonly metadata: { event_type?: string; event_payload?: Record<string, unknown> } | undefined;
}

interface RecordedAttachment {
  color?: unknown;
  fallback?: unknown;
  blocks?: unknown;
}

/** Only a real string counts; anything else is treated as absent rather than coerced. */
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export interface RecordedEphemeral {
  readonly channel: string;
  readonly user: string;
  readonly text: string;
  readonly blocks: AnyBlock[];
}

export class FakeSlackClient {
  readonly posts: RecordedPost[] = [];
  readonly ephemerals: RecordedEphemeral[] = [];
  /** History the fake returns, as if previously posted. */
  history: { ts: string; metadata?: { event_payload?: Record<string, unknown> } }[] = [];

  failNextPost: Error | null = null;
  failHistory: Error | null = null;
  #ts = 1000;

  readonly chat = {
    postMessage: (args: {
      channel?: unknown;
      text?: unknown;
      blocks?: unknown;
      attachments?: unknown;
      metadata?: unknown;
    }): Promise<{ ok: true; ts: string }> => {
      if (this.failNextPost) {
        const error = this.failNextPost;
        this.failNextPost = null;
        return Promise.reject(error);
      }

      const attachment = (Array.isArray(args.attachments) ? args.attachments[0] : undefined) as
        RecordedAttachment | undefined;

      this.posts.push({
        channel: String(args.channel),
        text: asText(attachment?.fallback) ?? asText(args.text) ?? '',
        blocks: (attachment?.blocks ?? args.blocks ?? []) as AnyBlock[],
        accent: typeof attachment?.color === 'string' ? attachment.color : undefined,
        metadata: args.metadata as RecordedPost['metadata'],
      });

      this.#ts += 1;
      return Promise.resolve({ ok: true, ts: `${String(this.#ts)}.000100` });
    },

    postEphemeral: (args: {
      channel?: unknown;
      user?: unknown;
      text?: unknown;
      blocks?: unknown;
    }): Promise<{ ok: true }> => {
      this.ephemerals.push({
        channel: String(args.channel),
        user: String(args.user),
        text: String(args.text),
        blocks: (args.blocks ?? []) as AnyBlock[],
      });
      return Promise.resolve({ ok: true });
    },
  };

  readonly conversations = {
    history: (): Promise<{ ok: true; messages: unknown[] }> => {
      if (this.failHistory) return Promise.reject(this.failHistory);
      return Promise.resolve({ ok: true, messages: this.history });
    },
  };

  /** The fake satisfies only the surface the message service uses. */
  asWebClient(): WebClient {
    return this as unknown as WebClient;
  }

  reset(): void {
    this.posts.length = 0;
    this.ephemerals.length = 0;
    this.history = [];
    this.failNextPost = null;
    this.failHistory = null;
  }
}
