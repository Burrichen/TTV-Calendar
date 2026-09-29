/**
 * The Worker.
 *
 * It does two things, and deliberately nothing else:
 *
 *   `POST /slack/interactions` — the Opt In / Opt Out buttons. Slack needs a public
 *                                HTTPS endpoint to deliver these to, and that is the
 *                                only reason this Worker exists.
 *   `/api/...`                 — a small, secured state API that lends D1 to the
 *                                GitHub Actions runner.
 *
 * There is **no Cron Trigger and no `scheduled` handler**. An earlier iteration made
 * this Worker the whole application — fetching Tennis TV, monitoring matches, posting
 * the daily, weekly and monthly reports on a 20-minute cron. That was reversed: the
 * Node application on GitHub Actions is the production runtime, and Cloudflare is
 * reduced to the two jobs above (docs/ARCHITECTURE.md §17, Architecture History).
 *
 * Nothing here logs a request body, a header, or a secret.
 */

import { newRunId } from '../src/logging/run-id.ts';
import type { Logger } from '../src/logging/types.ts';
import { handleStateApi } from './api/state.ts';
import { ConfigurationError, loadConfig, type Config, type WorkerEnv } from './config.ts';
import { createWorkerLogger } from './logger.ts';
import { handleInteraction } from './slack/interactions.ts';
import { verifySlackRequest } from './slack/verify.ts';
import { SlackViews } from './slack/views.ts';

interface Runtime {
  readonly config: Config;
  readonly logger: Logger;
}

export default {
  // `ExecutionContext` is unused: there is no deferred work. Every response is fully
  // resolved before it is returned, so nothing needs `waitUntil`.
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cheap, unauthenticated, and says nothing that is not already public.
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', service: 'ttv-calendar-worker' });
    }

    let runtime: Runtime;
    try {
      const config = loadConfig(env);
      runtime = {
        config,
        logger: createWorkerLogger(config.logLevel, { runId: newRunId(), path: url.pathname }),
      };
    } catch (error) {
      // The message names variables, never values.
      const detail = error instanceof ConfigurationError ? error.message : 'misconfigured';
      return json({ error: 'configuration', detail }, 500);
    }

    if (url.pathname === '/slack/interactions') {
      return handleSlackInteraction(request, env, runtime);
    }

    const api = await handleStateApi(request, url, {
      db: env.DB,
      config: runtime.config,
      logger: runtime.logger,
    });
    if (api !== null) return api;

    return json({ error: 'not_found' }, 404);
  },
};

/**
 * Slack button clicks.
 *
 * The body is read as text exactly once, before anything parses it, because that is the
 * byte sequence Slack signed. Verification happens before the payload is examined at
 * all — an unverified request never reaches D1.
 */
async function handleSlackInteraction(
  request: Request,
  env: WorkerEnv,
  runtime: Runtime,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const body = await request.text();

  const verification = await verifySlackRequest({
    signingSecret: runtime.config.slack.signingSecret,
    signature: request.headers.get('x-slack-signature'),
    timestamp: request.headers.get('x-slack-request-timestamp'),
    body,
  });

  if (!verification.ok) {
    // The reason is logged; the body is not. A rejected request is untrusted input, and
    // recording it would be recording whatever an attacker chose to send.
    runtime.logger.warn({ reason: verification.reason }, 'rejected unverified Slack request');
    return json({ error: 'unauthorized' }, 401);
  }

  const botToken = runtime.config.slack.botToken;

  return handleInteraction(body, {
    db: env.DB,
    logger: runtime.logger,
    fallbackChannelId: runtime.config.slack.channelId,
    now: new Date(),
    // Only the calendar modals need this. Without a token the subscription buttons
    // still work and a calendar click logs a warning rather than failing the request.
    views: botToken === null ? null : new SlackViews({ botToken }),
    timezone: runtime.config.timezone,
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
