/**
 * Structured logging. JSON on stdout, collected by the platform (ARCHITECTURE.md §11).
 *
 * Secrets never reach the logs: tokens and connection strings are redacted by path,
 * and the redaction list is deliberately broad.
 */

import { pino, type DestinationStream } from 'pino';

import type { Logger } from './types.ts';

export type { LogFields, Logger } from './types.ts';

/**
 * Everything that must never reach a log line.
 *
 * Deliberately broad, and covering the shapes these values actually appear in: at the
 * top level, nested one deep under any key (`config.slack.botToken`, but also an error
 * object carrying `data.token`), and inside HTTP headers.
 *
 * Redaction is the second line of defence, not the first — nothing in the codebase
 * logs a config object or a raw request. This exists for the case nobody thought of.
 */
export const REDACT_PATHS = [
  'token',
  'botToken',
  'appToken',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'apiKey',
  'signingSecret',
  'databaseUrl',
  'connectionString',
  '*.token',
  '*.botToken',
  '*.appToken',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.connectionString',
  '*.*.token',
  '*.*.botToken',
  '*.*.appToken',
  '*.*.password',
  'config.slack.botToken',
  'config.slack.appToken',
  'config.database.url',
  'err.data.token',
  'err.data.*.token',
  '*.data.token',
  'req.headers.authorization',
  'headers.authorization',
  'headers.cookie',
] as const;

export interface LoggerOptions {
  readonly level: string;
  /**
   * Where the log lines go. Defaults to stdout.
   *
   * Injectable so tests can assert against the REAL logger configuration — including
   * its redaction — rather than a copy of it that could drift.
   */
  readonly destination?: DestinationStream;
}

/**
 * Always JSON on stdout, in every environment.
 *
 * There is no pretty-printing transport: it would be a production dependency used only
 * in development, and piping is the same thing without the dependency —
 * `npm run dev | npx pino-pretty`.
 */
export function createLogger(options: LoggerOptions): Logger {
  const settings = {
    level: options.level,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    base: { service: 'ttv-calendar-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string): Record<string, string> => ({ level: label }),
    },
  };

  return options.destination === undefined ? pino(settings) : pino(settings, options.destination);
}

// Re-exported so Node-side callers keep a single logging import.
export { newRunId } from './run-id.ts';

/** A logger that discards everything. For tests that exercise logging call sites. */
export const silentLogger = (): Logger => pino({ level: 'silent' });
