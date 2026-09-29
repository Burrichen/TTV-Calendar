/**
 * Logging inside a Worker.
 *
 * `console.log` is the only sink `workerd` offers, and Cloudflare collects whatever is
 * written to it (`wrangler tail`, and the dashboard's live logs). So this emits one
 * JSON object per line — the same shape `pino` produces on the Node side — which keeps
 * log lines greppable and machine-readable in both runtimes.
 *
 * Secrets are handled by not logging them. Unlike the `pino` configuration there is no
 * redaction pass: redaction is a safety net for accidental object logging, and in a
 * surface this small the honest control is that no call site ever logs a config, a
 * token, or a raw Slack payload. The tests assert that.
 */

import type { LogFields, Logger } from '../src/logging/types.ts';
import type { LogLevel } from './config.ts';

const ORDER = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 } as const;

/**
 * Every level this logger can emit. Wider than `LogLevel`, which is only what may be
 * *configured* — `fatal` is emittable but not a sensible threshold to set.
 */
type Level = keyof typeof ORDER;

type Sink = (line: string) => void;

class WorkerLogger implements Logger {
  readonly #level: LogLevel;
  readonly #threshold: number;
  readonly #bindings: LogFields;
  readonly #sink: Sink;

  constructor(level: LogLevel, bindings: LogFields, sink: Sink) {
    this.#level = level;
    this.#threshold = ORDER[level];
    this.#bindings = bindings;
    this.#sink = sink;
  }

  child(bindings: LogFields): Logger {
    return new WorkerLogger(this.#level, { ...this.#bindings, ...bindings }, this.#sink);
  }

  trace = this.#at('debug');
  debug = this.#at('debug');
  info = this.#at('info');
  warn = this.#at('warn');
  error = this.#at('error');
  fatal = this.#at('fatal');

  #at(level: Level) {
    return (first: LogFields | string, second?: string): void => {
      if (ORDER[level] < this.#threshold) return;

      const fields = typeof first === 'string' ? {} : first;
      const message = typeof first === 'string' ? first : second;

      this.#sink(
        JSON.stringify({
          level,
          time: new Date().toISOString(),
          service: 'ttv-calendar-worker',
          ...this.#bindings,
          ...serialiseFields(fields),
          ...(message === undefined ? {} : { msg: message }),
        }),
      );
    };
  }
}

/**
 * Errors do not survive `JSON.stringify` — it renders them as `{}`, which is how a
 * failure becomes invisible in a log aggregator. Expand the parts worth keeping.
 */
function serialiseFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  return out;
}

export function createWorkerLogger(
  level: LogLevel,
  bindings: LogFields = {},
  // Injectable so tests assert against real output instead of spying on the console.
  sink: Sink = (line): void => {
    console.log(line);
  },
): Logger {
  return new WorkerLogger(level, bindings, sink);
}
