/**
 * The only module permitted to read `process.env`.
 *
 * Everything else receives a validated, frozen `Config`. That keeps environment parsing
 * in one testable place and means a misconfigured workflow fails immediately — with
 * every problem listed at once — rather than half-way through a run that has already
 * posted to Slack (PROJECT_SPEC.md §13).
 *
 * The surface is small because the runtime is small. Each command starts, does one
 * thing and exits: there is no database to connect to, no port to listen on, and no
 * app-level token, because Slack button clicks arrive at the Cloudflare Worker rather
 * than at this process (docs/ARCHITECTURE.md §15).
 */

import { IANAZone } from 'luxon';
import { z } from 'zod';

// The provider owns its own addresses; configuration only overrides them.
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_API_BASE_URL,
  DEFAULT_SITE_BASE_URL,
} from '../tennistv/endpoints.ts';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const ianaZone = z.string().refine((value) => IANAZone.isValidZone(value), {
  message: 'must be an IANA time zone name, e.g. Europe/London — never a fixed offset',
});

/**
 * Drops variables that are present but empty.
 *
 * This is not cosmetic. GitHub Actions renders an unset `vars.APP_TIMEZONE` or an
 * absent `workflow_dispatch` input as an **empty string**, not as an absent variable —
 * so without this, leaving an optional repository variable unconfigured would fail
 * validation ("must be an IANA time zone name") instead of quietly using the default.
 * Treating blank as absent is what makes every optional variable genuinely optional.
 */
const withoutBlanks = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

const envSchema = z.object({
  // --- Slack ---------------------------------------------------------------
  /** Bot token (`xoxb-…`). A GitHub Actions secret. */
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  /** The one channel for summaries AND live alerts. A GitHub Actions variable. */
  SLACK_CHANNEL_ID: z.string().min(1),

  // --- State API (the Cloudflare Worker) -----------------------------------
  /** Base URL of the deployed Worker. A GitHub Actions variable. */
  STATE_API_URL: z.url(),
  /**
   * Shared secret for the Worker's internal API. A GitHub Actions secret.
   *
   * Presented as a bearer token, never in a URL, and never logged.
   */
  INTERNAL_API_SECRET: z.string().min(32),

  // --- Time ----------------------------------------------------------------
  APP_TIMEZONE: ianaZone.default('Europe/London'),
  /** The local hour the scheduled reports belong to. */
  SUMMARY_HOUR: z.coerce.number().int().min(0).max(23).default(8),

  // --- Tennis TV -----------------------------------------------------------
  TENNISTV_BASE_URL: z.url().default(DEFAULT_SITE_BASE_URL),
  TENNISTV_API_BASE_URL: z.url().default(DEFAULT_API_BASE_URL),
  TENNISTV_ACCOUNT_ID: z.string().min(1).default(DEFAULT_ACCOUNT_ID),
  TENNISTV_PROVIDER: z.enum(['live', 'fixture']).default('live'),

  // --- Behaviour -----------------------------------------------------------
  /** How much later a republished start must be before it is treated as a delay. */
  MONITOR_SCHEDULE_SLIP_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  /** How long finished match state and settled notifications are kept. */
  STATE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /**
   * A whole-run ceiling, enforced by the command itself.
   *
   * The workflow has its own `timeout-minutes`, but that kills the job without a
   * diagnostic. This fires first and says what it was doing.
   */
  RUN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(240),

  // --- Runtime -------------------------------------------------------------
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Logs outbound Slack calls instead of making them. */
  SLACK_DRY_RUN: booleanish.default(false),
});

type Env = z.infer<typeof envSchema>;

/** Grouped, frozen configuration. Consumers take the slice they need, not the whole. */
export interface Config {
  readonly timezone: string;
  readonly summaryHour: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly runTimeoutSeconds: number;
  readonly slack: {
    readonly botToken: string;
    readonly channelId: string;
    readonly dryRun: boolean;
  };
  readonly stateApi: {
    readonly baseUrl: string;
    readonly secret: string;
  };
  readonly tennisTv: {
    readonly siteBaseUrl: string;
    readonly apiBaseUrl: string;
    readonly accountId: string;
    readonly provider: Env['TENNISTV_PROVIDER'];
  };
  readonly monitor: {
    readonly scheduleSlipMinutes: number;
  };
  readonly retention: {
    readonly stateDays: number;
  };
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

/**
 * Validates the environment and returns a frozen `Config`.
 *
 * @throws ConfigurationError listing every problem, so one workflow run surfaces them
 *         all instead of one per attempt. The message names variables, never values,
 *         so an invalid token cannot be echoed into a build log.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(withoutBlanks(source));

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(
      `Invalid configuration — ${String(result.error.issues.length)} problem(s):\n${problems}\n\n` +
        'See .env.example for the full set, and docs/ARCHITECTURE.md §15 for which are ' +
        'GitHub Secrets and which are GitHub Variables.',
    );
  }

  const env = result.data;

  return Object.freeze({
    timezone: env.APP_TIMEZONE,
    summaryHour: env.SUMMARY_HOUR,
    logLevel: env.LOG_LEVEL,
    runTimeoutSeconds: env.RUN_TIMEOUT_SECONDS,
    slack: Object.freeze({
      botToken: env.SLACK_BOT_TOKEN,
      channelId: env.SLACK_CHANNEL_ID,
      dryRun: env.SLACK_DRY_RUN,
    }),
    stateApi: Object.freeze({
      baseUrl: env.STATE_API_URL,
      secret: env.INTERNAL_API_SECRET,
    }),
    tennisTv: Object.freeze({
      siteBaseUrl: env.TENNISTV_BASE_URL,
      apiBaseUrl: env.TENNISTV_API_BASE_URL,
      accountId: env.TENNISTV_ACCOUNT_ID,
      provider: env.TENNISTV_PROVIDER,
    }),
    monitor: Object.freeze({
      scheduleSlipMinutes: env.MONITOR_SCHEDULE_SLIP_MINUTES,
    }),
    retention: Object.freeze({
      stateDays: env.STATE_RETENTION_DAYS,
    }),
  });
}
