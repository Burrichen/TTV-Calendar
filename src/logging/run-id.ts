/**
 * A short correlation ID for one unit of work — a sync, a cron tick, a button click.
 *
 * Every log line from that work carries it, so a failure hours later can be traced back
 * through the exact sequence of steps that produced it. Short enough to read in a
 * terminal, random enough not to collide within one invocation's lifetime.
 *
 * Lives apart from the `pino` logger because both runtimes need it — the Worker has no
 * `pino`, but it very much has units of work worth correlating.
 */
export const newRunId = (): string => Math.random().toString(36).slice(2, 10);
