/**
 * Worker configuration.
 *
 * The Worker's job is narrow: accept Slack button clicks, and lend its D1 database to
 * the Node application that does the real work. So this is narrow too — no Tennis TV
 * settings, no scheduling, no reporting. If a value here is not needed to verify a
 * Slack request, write a subscription, or authorise the state API, it does not belong.
 *
 * A Worker has no boot, so configuration is parsed per invocation rather than once.
 * That is cheap and it means a bad `wrangler` variable fails the first request rather
 * than lying dormant.
 */

import { IANAZone } from 'luxon';
import { z } from 'zod';

/**
 * Everything Cloudflare injects.
 *
 * Secrets (`wrangler secret put`) and plain variables (`vars` in wrangler.jsonc) arrive
 * on the same object; the distinction is operational, not structural, so it is recorded
 * in the comments rather than in the type.
 */
export interface WorkerEnv {
  /** D1 binding. Declared in wrangler.jsonc. */
  readonly DB: D1Database;

  // --- secrets -------------------------------------------------------------
  /** Slack's request-signing secret. `wrangler secret put SLACK_SIGNING_SECRET`. */
  readonly SLACK_SIGNING_SECRET: string;
  /**
   * Bot token (`xoxb-…`), used only to open and update calendar modals.
   *
   * A modal can only be opened by the app that received the click, inside Slack's
   * interaction deadline, so this cannot be delegated to the GitHub runner. The Worker
   * still posts no messages: `views.open` and `views.update` are its entire outbound
   * Slack surface.
   *
   * Optional. Without it the subscription buttons keep working and the calendar buttons
   * explain that the view is unavailable, rather than the whole Worker failing.
   */
  readonly SLACK_BOT_TOKEN?: string;
  /**
   * Shared secret the GitHub Actions runner presents to the internal API.
   *
   * The same value is held as a GitHub Actions secret. It is the only credential
   * GitHub ever sees — it confers access to these endpoints and nothing else, never to
   * Cloudflare or to D1 directly.
   *
   * Optional: when unset the internal API is disabled outright rather than left open.
   */
  readonly INTERNAL_API_SECRET?: string;

  // --- variables -----------------------------------------------------------
  /**
   * The channel subscriptions belong to.
   *
   * Only a fallback: a button click carries its own channel, and that is preferred.
   * This covers the rare payload that arrives without one.
   */
  readonly SLACK_CHANNEL_ID: string;
  /**
   * The zone every date in a calendar view is shown in.
   *
   * Must match the runner's `APP_TIMEZONE`, or a modal would label a snapshot's dates
   * differently from the message that linked to it.
   */
  readonly APP_TIMEZONE?: string;
  readonly LOG_LEVEL?: string;
}

const schema = z.object({
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-').optional(),
  // Long enough that guessing is not worth attempting; generated, not chosen.
  INTERNAL_API_SECRET: z.string().min(32).optional(),
  SLACK_CHANNEL_ID: z.string().min(1),
  APP_TIMEZONE: z
    .string()
    .refine((value) => IANAZone.isValidZone(value), {
      message: 'must be an IANA time zone name, e.g. Europe/London — never a fixed offset',
    })
    .default('Europe/London'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type LogLevel = z.infer<typeof schema>['LOG_LEVEL'];

export interface Config {
  readonly logLevel: LogLevel;
  readonly timezone: string;
  readonly slack: {
    readonly signingSecret: string;
    readonly botToken: string | null;
    readonly channelId: string;
  };
  readonly stateApi: { readonly secret: string | null };
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

/**
 * Whether the D1 binding is actually present.
 *
 * Takes `unknown` deliberately. `WorkerEnv` declares `DB` as always there, but that is
 * a promise about how the Worker is configured, not a fact about runtime: rename the
 * binding in wrangler.jsonc and it is `undefined`. Validating it as external input is
 * the same treatment every other untrusted value gets.
 */
function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function'
  );
}

/**
 * Validates the bindings and returns a frozen `Config`.
 *
 * @throws ConfigurationError naming every problem at once. The message names variables,
 *         never values, so a misconfigured secret cannot be echoed into a log line.
 */
export function loadConfig(env: WorkerEnv): Config {
  // Checked before the variables, because a missing binding is otherwise invisible: the
  // Worker starts, authenticates the request, and only fails when it first touches the
  // database — as an opaque 500 with no hint of the cause.
  if (!isD1Binding(env.DB)) {
    throw new ConfigurationError(
      'The D1 binding "DB" is missing.\n\n' +
        'In wrangler.jsonc, d1_databases[0].binding must be exactly "DB" — that is the ' +
        'name the Worker reads. `wrangler d1 create` suggests a binding named after the ' +
        'database instead, so check you took only the database_id from its output.\n\n' +
        'Fix it, then run `npm run worker:deploy` again.',
    );
  }

  const result = schema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(
      `Invalid Worker configuration — ${String(result.error.issues.length)} problem(s):\n` +
        `${problems}\n\nSee docs/ARCHITECTURE.md §16 for where each value comes from.`,
    );
  }

  const parsed = result.data;

  return Object.freeze({
    logLevel: parsed.LOG_LEVEL,
    timezone: parsed.APP_TIMEZONE,
    slack: Object.freeze({
      signingSecret: parsed.SLACK_SIGNING_SECRET,
      botToken: parsed.SLACK_BOT_TOKEN ?? null,
      channelId: parsed.SLACK_CHANNEL_ID,
    }),
    stateApi: Object.freeze({ secret: parsed.INTERNAL_API_SECRET ?? null }),
  });
}
