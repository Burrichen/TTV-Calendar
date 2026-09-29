/**
 * The logger interface the application actually depends on.
 *
 * Deliberately structural rather than a concrete implementation's type. The same
 * domain, provider and presentation code runs in two runtimes now — Node for the CLI
 * and reconnaissance scripts, Cloudflare Workers for production — and those runtimes
 * cannot share a logging library: `pino` writes to Node streams, which `workerd` does
 * not have.
 *
 * Both implementations satisfy this interface, so nothing below the runtime boundary
 * has to know which one it is talking to. See docs/CLOUDFLARE_COMPATIBILITY.md §1.5.
 */

/** Structured fields attached to a line. `err` is conventionally an Error. */
export type LogFields = Record<string, unknown>;

export interface LogFn {
  (fields: LogFields, message?: string): void;
  (message: string): void;
}

export interface Logger {
  /** Returns a logger that adds `bindings` to every line it writes. */
  child(bindings: LogFields): Logger;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
}
