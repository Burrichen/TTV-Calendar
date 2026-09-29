/**
 * One morning run: the daily, weekly and monthly reports.
 *
 * Scheduling is not decided here. `dueOccurrences` answers "which reports should have
 * gone out by now and are still worth sending" from the clock alone, in
 * `Europe/London`; the state API answers "and have they". That split is what makes a
 * UTC cron deliver a correct 08:00 local report in both BST and GMT without a single
 * offset being written down (docs/ARCHITECTURE.md §15).
 *
 * It also means a run GitHub never started — a runner outage, a queue backlog — is
 * caught up by the next one, for as long as the report is still current. A weekly
 * report is still worth having on Tuesday; never the following week.
 */

import type { Config } from '../config/env.ts';
import type { Match, Tournament } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import { dueOccurrences, type Occurrence } from '../schedule/occurrences.ts';
import { reportKey } from '../schedule/report-keys.ts';
import { refreshSnapshots } from '../schedule/snapshots.ts';
import {
  fetchMatches,
  fetchTournaments,
  matchesWithin,
  tournamentsWithin,
  widen,
} from '../schedule/schedule-reader.ts';
import {
  buildDailySummary,
  buildMonthlySummary,
  buildWeeklySummary,
  type BuiltMessage,
} from '../slack/blocks/summaries.ts';
import type { SlackPublisher } from '../slack/publisher.ts';
import type { StateApi } from '../state/client.ts';
import type { DateRange, TennisTvProvider } from '../tennistv/provider.ts';

export interface MorningRunOptions {
  readonly provider: TennisTvProvider;
  readonly publisher: SlackPublisher;
  readonly state: StateApi;
  readonly config: Config;
  readonly logger: Logger;
  readonly now: Date;
  /** Renders with the 🧪 TEST banner and throwaway keys, leaving real keys untouched. */
  readonly simulated?: boolean;
  /**
   * Ignores whether a report is due, and renders the given kinds regardless.
   *
   * For `workflow_dispatch` previews. Always combined with `simulated`, so a preview
   * can never consume a real report key.
   */
  readonly force?: readonly Occurrence[];
}

export interface MorningRunResult {
  readonly due: readonly string[];
  readonly posted: number;
  readonly skipped: number;
  readonly failed: number;
}

export async function runMorning(options: MorningRunOptions): Promise<MorningRunResult> {
  const { config, logger, now } = options;

  const due =
    options.force ?? dueOccurrences(now, { timezone: config.timezone, hour: config.summaryHour });

  if (due.length === 0) {
    // Normal and expected: a UTC cron fires at an hour that is not yet 08:00 locally.
    logger.info('no reports are due at this local time');
    return { due: [], posted: 0, skipped: 0, failed: 0 };
  }

  // Which of those still need doing — asked before any Tennis TV request, so the run
  // that fires an hour "early" or "late" costs one state API call and nothing else.
  const outstanding = options.force ?? (await filterOutstanding(due, options));

  if (outstanding.length === 0) {
    logger.info(
      { due: due.map((occurrence) => occurrence.kind) },
      'every due report has already been sent',
    );
    return {
      due: due.map((occurrence) => occurrence.kind),
      posted: 0,
      skipped: due.length,
      failed: 0,
    };
  }

  logger.info(
    { outstanding: outstanding.map((occurrence) => occurrence.kind) },
    'reports outstanding',
  );

  const schedule = await readSchedule(outstanding, options);

  // The schedule is already in memory, so the snapshots the calendar modals read cost
  // two state API calls and no extra Tennis TV request. Done before the reports so a
  // "View week" button is answerable the moment its message lands.
  await refreshSnapshots({
    state: options.state,
    logger: options.logger,
    timezone: config.timezone,
    now,
    tournaments: schedule.tournaments,
    matches: schedule.matches,
    variant: options.simulated === true ? 'TEST' : 'LIVE',
  });

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const occurrence of outstanding) {
    try {
      const outcome = await sendReport(occurrence, schedule, options);
      if (outcome === 'posted') posted += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    } catch (error) {
      // One report failing must not abandon the others; they are independent
      // requirements (PROJECT_SPEC.md §4).
      failed += 1;
      logger.error({ err: error, kind: occurrence.kind }, 'report failed');
    }
  }

  // Once a day, on the run that actually did the morning's work, tidy up. Deliberately
  // here rather than in the monitor: this path runs once daily, whereas the monitor
  // runs 48 times and would be paying for a sweep that has nothing to do.
  if (options.simulated !== true) await prune(options);

  return { due: due.map((occurrence) => occurrence.kind), posted, skipped, failed };
}

/**
 * Deletes match state and settled notifications past their retention window.
 *
 * Never allowed to fail the run: retention is housekeeping, and a report that was sent
 * successfully must not be reported as a failure because a cleanup call did not land.
 */
async function prune(options: MorningRunOptions): Promise<void> {
  const before = new Date(
    options.now.getTime() - options.config.retention.stateDays * 24 * 60 * 60 * 1000,
  );

  try {
    const result = await options.state.prune(before);
    options.logger.info(
      { ...result, before: before.toISOString() },
      'pruned state past its retention window',
    );
  } catch (error) {
    options.logger.warn({ err: error }, 'retention sweep failed; will be retried tomorrow');
  }
}

/** Drops occurrences whose key is already settled. */
async function filterOutstanding(
  due: readonly Occurrence[],
  options: MorningRunOptions,
): Promise<Occurrence[]> {
  const keys = due.map((occurrence) => reportKey(occurrence, options.config.timezone));
  const statuses = await options.state.statuses(keys);

  return due.filter((occurrence) => {
    const status = statuses[reportKey(occurrence, options.config.timezone)] ?? null;
    // PENDING counts as outstanding: a previous attempt failed part-way, and the claim
    // logic decides whether this run may take it over.
    return status === null || status === 'PENDING';
  });
}

interface LoadedSchedule {
  readonly tournaments: readonly Tournament[];
  readonly matches: readonly Match[];
}

/**
 * One read covering every outstanding report.
 *
 * A Monday the 1st therefore costs the same tournament fetch as an ordinary Tuesday,
 * and the provider's cache makes the per-tournament match reads shared across all three.
 */
async function readSchedule(
  outstanding: readonly Occurrence[],
  options: MorningRunOptions,
): Promise<LoadedSchedule> {
  const windows = outstanding.map((occurrence) => occurrence.window);
  const span: DateRange = widen(windows[0] ?? { from: '', to: '' }, windows);

  const { tournaments, skipped } = await fetchTournaments(options.provider, span, options.logger);
  if (skipped > 0) {
    options.logger.warn({ skipped }, 'Tennis TV returned records the provider could not read');
  }

  const { matches, failed } = await fetchMatches(options.provider, tournaments, options.logger);
  if (failed > 0) {
    options.logger.warn({ failed }, 'some tournaments could not be read; reports may be partial');
  }

  return { tournaments, matches };
}

type ReportOutcome = 'posted' | 'skipped' | 'failed';

async function sendReport(
  occurrence: Occurrence,
  schedule: LoadedSchedule,
  options: MorningRunOptions,
): Promise<ReportOutcome> {
  const { config, logger, now } = options;
  const realKey = reportKey(occurrence, config.timezone);
  // A preview must never consume the real key, so it gets a timestamped one.
  const key = options.simulated === true ? `sim:${realKey}:${String(now.getTime())}` : realKey;

  const built = render(occurrence, schedule, config);

  if (built === null) {
    // A daily report with nothing on it. The key is settled so the decision is not
    // revisited by a later run this morning, but nothing is posted
    // (PROJECT_SPEC.md §4.1).
    const claim = await options.state.claim({
      key,
      kind: 'REPORT',
      reference: occurrence.occurrenceDate,
      now,
    });

    if (claim.status === 'claimed') {
      await options.state.settle({
        key,
        outcome: 'suppressed',
        now,
        reason: 'no matches scheduled',
      });
      logger.info({ key }, 'nothing scheduled today; no daily report posted');
    }

    return 'skipped';
  }

  const outcome = await options.publisher.publish(
    {
      key,
      kind: 'REPORT',
      reference: occurrence.occurrenceDate,
      blocks: built.blocks,
      text: built.text,
      ...(options.simulated === true ? { simulated: true } : {}),
    },
    now,
  );

  if (outcome.status === 'sent') return 'posted';
  if (outcome.status === 'failed') return 'failed';
  return 'skipped';
}

/**
 * Builds the message for one occurrence, or null when there is nothing to send.
 *
 * Null is only ever returned for the daily report. Weekly and monthly always post,
 * saying plainly that nothing is scheduled — silence there is indistinguishable from a
 * broken bot (PROJECT_SPEC.md §4.2, §4.3).
 */
function render(
  occurrence: Occurrence,
  schedule: LoadedSchedule,
  config: Config,
): BuiltMessage | null {
  const { from, to } = occurrence.window;
  const options = { timezone: config.timezone };
  const tournaments = tournamentsWithin(schedule.tournaments, from, to);
  const matches = matchesWithin(schedule.matches, from, to, config.timezone);

  switch (occurrence.kind) {
    case 'DAILY':
      if (matches.length === 0) return null;
      return buildDailySummary({ date: from, matches, tournaments }, options);

    case 'WEEKLY':
      return buildWeeklySummary({ from, to, matches, tournaments }, options);

    case 'MONTHLY':
      return buildMonthlySummary({ from, to, tournaments, matches }, options);
  }
}
