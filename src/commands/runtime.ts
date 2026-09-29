/**
 * The shared bootstrap for every command.
 *
 * Each command is a short-lived process: it starts, does one thing and exits. This
 * module owns the parts that are identical across them — building the dependencies,
 * bounding the total run time, and turning an outcome into an exit code — so that each
 * command file contains only what makes it different.
 *
 * Exit codes matter more than usual here, because they are the only signal GitHub
 * Actions has. A non-zero exit marks the job red; a zero exit with a warning in the log
 * is how "nothing to do" and "partially degraded" are reported.
 */

import { WebClient } from '@slack/web-api';

import { ConfigurationError, loadConfig, type Config } from '../config/env.ts';
import { createLogger, newRunId, type Logger } from '../logging/logger.ts';
import { SlackPublisher } from '../slack/publisher.ts';
import { HttpStateApi, type StateApi } from '../state/client.ts';
import { createTennisTvProvider } from '../tennistv/index.ts';
import type { TennisTvProvider } from '../tennistv/provider.ts';

export interface Runtime {
  readonly config: Config;
  readonly logger: Logger;
  readonly provider: TennisTvProvider;
  readonly state: StateApi;
  readonly publisher: SlackPublisher;
}

/** Builds everything a command needs from the environment. */
export function buildRuntime(command: string): Runtime {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel }).child({
    command,
    runId: newRunId(),
  });

  const provider = createTennisTvProvider({
    mode: config.tennisTv.provider,
    apiBaseUrl: config.tennisTv.apiBaseUrl,
    siteBaseUrl: config.tennisTv.siteBaseUrl,
    accountId: config.tennisTv.accountId,
    logger,
  });

  const state = new HttpStateApi({
    baseUrl: config.stateApi.baseUrl,
    secret: config.stateApi.secret,
  });

  const publisher = new SlackPublisher({
    client: new WebClient(config.slack.botToken, {
      // Bounded so a hanging Slack call cannot consume the whole run budget.
      timeout: 10_000,
      retryConfig: { retries: 2 },
    }),
    state,
    logger,
    channelId: config.slack.channelId,
    dryRun: config.slack.dryRun,
  });

  return { config, logger, provider, state, publisher };
}

/** Raised when a command exceeds its own budget, before the workflow's kills it. */
export class RunTimeoutError extends Error {
  override readonly name = 'RunTimeoutError';

  constructor(seconds: number) {
    super(`Run exceeded its ${String(seconds)}s budget and was abandoned.`);
  }
}

/**
 * Runs `work`, bounded by `RUN_TIMEOUT_SECONDS`.
 *
 * The workflow's own `timeout-minutes` is the backstop; this fires first and produces a
 * named error and a log line, which a killed job does not.
 */
async function withTimeout<T>(seconds: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RunTimeoutError(seconds));
        }, seconds * 1000);
        // Do not hold the event loop open on account of the watchdog.
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The outer shell of every command.
 *
 * Owns the whole lifecycle: build, run under a time limit, log the result, release the
 * provider, and exit with a code that says what happened. Any escaping error is logged
 * as structured JSON and exits 1, so a failure is never a silent green tick.
 */
export async function execute<T>(
  command: string,
  work: (runtime: Runtime) => Promise<T>,
  summarise: (result: T) => Record<string, unknown>,
): Promise<void> {
  let runtime: Runtime;

  try {
    runtime = buildRuntime(command);
  } catch (error) {
    // No logger exists yet, and no configuration to build one from.
    const message =
      error instanceof ConfigurationError ? error.message : 'failed to start: unknown error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  runtime.logger.info({ timezone: runtime.config.timezone }, `${command} started`);

  try {
    const result = await withTimeout(runtime.config.runTimeoutSeconds, () => work(runtime));

    runtime.logger.info(
      { durationMs: Date.now() - started, ...summarise(result) },
      `${command} completed`,
    );
  } catch (error) {
    runtime.logger.error({ err: error, durationMs: Date.now() - started }, `${command} failed`);
    process.exitCode = 1;
  } finally {
    // Releases the provider's cache timers so the process can exit promptly.
    runtime.provider.close();
  }
}
