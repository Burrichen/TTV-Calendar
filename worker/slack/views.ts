/**
 * Opening and updating Slack modals.
 *
 * The Worker's only outbound Slack calls. It still posts no messages — every public
 * message comes from the GitHub Actions runner — but a modal can only be opened by the
 * app that received the click, inside Slack's three-second interaction deadline, so
 * this has to happen here.
 *
 * Deliberately two methods and nothing else: a `fetch` wrapper rather than a Slack SDK,
 * because the whole surface is `views.open` and `views.update`.
 */

import type { ModalView } from '@slack/types';

export class SlackViewError extends Error {
  override readonly name = 'SlackViewError';
  readonly code: string;

  constructor(code: string) {
    super(`Slack views API error: ${code}`);
    this.code = code;
  }
}

export interface SlackViewsOptions {
  readonly botToken: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class SlackViews {
  readonly #botToken: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SlackViewsOptions) {
    this.#botToken = options.botToken;
    this.#baseUrl = (options.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '');
    // Well inside Slack's interaction deadline: a slow call must fail in time for the
    // handler to still return a 200.
    this.#timeoutMs = options.timeoutMs ?? 2500;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Opens a modal against a `trigger_id`, which Slack expires after a few seconds. */
  open(triggerId: string, view: ModalView): Promise<void> {
    return this.#call('views.open', { trigger_id: triggerId, view });
  }

  /** Replaces the contents of an open modal, for pagination. */
  update(viewId: string, view: ModalView): Promise<void> {
    return this.#call('views.update', { view_id: viewId, view });
  }

  async #call(method: string, payload: object): Promise<void> {
    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#botToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SlackViewError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'request_timeout'
          : 'network_error',
      );
    }

    if (!response.ok) throw new SlackViewError(`http_${String(response.status)}`);

    // Slack signals application errors with HTTP 200 and `ok: false`.
    const body = await response.json<{ ok?: boolean; error?: string }>();
    if (body.ok !== true) {
      throw new SlackViewError(typeof body.error === 'string' ? body.error : 'unknown_error');
    }
  }
}
