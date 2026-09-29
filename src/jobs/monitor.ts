/**
 * One live-monitoring run.
 *
 * Runs every 30 minutes on GitHub Actions. What makes it safe is entirely in what it
 * refuses to infer:
 *
 *  - a match that **disappears** from the feed is not cancelled. Only matches present
 *    in the snapshot are considered at all, so an absent one simply keeps its stored
 *    state (PROJECT_SPEC.md §6.4);
 *  - a match whose **start time has passed** is not delayed. Nothing here compares a
 *    scheduled time to the clock; a delay is either explicitly reported by Tennis TV,
 *    or is Tennis TV republishing the match at a later time;
 *  - a status code we do not recognise maps to `UNKNOWN`, which the state machine
 *    treats as inert in both directions, so drift upstream cannot manufacture an alert.
 *
 * Ordering within a run is deliberate: alerts are sent **before** the new state is
 * written. A failed send therefore leaves the old state in place, the transition is
 * re-detected on the next run, and the pending claim is retried — rather than the
 * transition being forgotten because we recorded it as seen.
 */

import { detectStateChange, type StateChange } from '../domain/match-state.ts';
import { matchKey, tournamentKey, type Match, type TournamentId } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import { fetchTournaments, tournamentsWithin } from '../schedule/schedule-reader.ts';
import { buildAlert } from '../slack/blocks/alerts.ts';
import type { SlackPublisher } from '../slack/publisher.ts';
import type { MatchStateRecord, StateApi } from '../state/client.ts';
import { todayRange } from '../sync/windows.ts';
import { availableMatches } from '../domain/availability.ts';
import type { TennisTvProvider } from '../tennistv/provider.ts';
import type { Config } from '../config/env.ts';

export interface MonitorRunOptions {
  readonly provider: TennisTvProvider;
  readonly publisher: SlackPublisher;
  readonly state: StateApi;
  readonly config: Config;
  readonly logger: Logger;
  readonly now: Date;
}

export interface MonitorRunResult {
  readonly tournamentsToday: number;
  readonly checked: number;
  readonly transitions: number;
  readonly alerted: number;
  readonly suppressed: number;
  readonly failed: number;
  readonly subscribers: number;
}

const NOTHING_ON: MonitorRunResult = {
  tournamentsToday: 0,
  checked: 0,
  transitions: 0,
  alerted: 0,
  suppressed: 0,
  failed: 0,
  subscribers: 0,
};

export async function runMonitor(options: MonitorRunOptions): Promise<MonitorRunResult> {
  const { config, logger, now } = options;
  const today = todayRange(now, config.timezone);

  const { tournaments, skipped } = await fetchTournaments(options.provider, today, logger);
  const runningToday = tournamentsWithin(tournaments, today.from, today.to);

  // One line, at info, that says the upstream read worked and what it found. A failure
  // throws and is logged as an error by the command, so between the two there is always
  // an unambiguous record of how Tennis TV answered.
  logger.info(
    {
      date: today.from,
      tournaments: tournaments.length,
      runningToday: runningToday.length,
      skipped,
    },
    'Tennis TV read ok',
  );

  if (skipped > 0) {
    logger.warn({ skipped }, 'Tennis TV returned records the provider could not read');
  }

  if (runningToday.length === 0) {
    // Nothing is on. No further request is made — the cheapest possible run, and the
    // most common one.
    logger.info('no tournaments running today; nothing to monitor');
    return NOTHING_ON;
  }

  const tournamentIds: readonly TournamentId[] = runningToday.map((tournament) => tournament.id);
  const snapshot = await options.provider.getLiveState(tournamentIds);
  const matches = availableMatches(snapshot.matches);
  logger.info({ matches: matches.length, skipped: snapshot.skipped }, 'live state read ok');

  if (matches.length === 0) {
    logger.info({ tournaments: runningToday.length }, 'no matches in live snapshot');
    return { ...NOTHING_ON, tournamentsToday: runningToday.length };
  }

  const keys = matches.map((match) => matchKey(match.id));
  const previous = await options.state.loadMatchStates(keys);

  // Detect first, before anything is written or sent, so every decision in one run is
  // made against a single consistent view.
  const changes: { match: Match; change: StateChange }[] = [];
  for (const match of matches) {
    const stored = previous.get(matchKey(match.id));
    const change = detectStateChange(
      stored === undefined ? null : { status: stored.status, startsAtUtc: stored.startsAtUtc },
      { status: match.status, startsAtUtc: match.schedule.startsAtUtc },
      { scheduleSlipMinutes: config.monitor.scheduleSlipMinutes },
    );

    if (change !== null) changes.push({ match, change });
  }

  // Only asked for when there is something to say, so an idle run makes no call.
  const subscribers =
    changes.length === 0 ? [] : await options.state.subscribers(options.publisher.channelId);

  let alerted = 0;
  let suppressed = 0;
  let failed = 0;
  /** Matches whose alert failed: their old state is kept so the run can be repeated. */
  const unrecorded = new Set<string>();

  for (const { match, change } of changes) {
    const key = matchKey(match.id);

    logger.info(
      { match: key, from: change.from, to: change.to, subscribers: subscribers.length },
      'state transition detected',
    );

    if (subscribers.length === 0) {
      // Nobody to tell. The state is still recorded below, so that when somebody does
      // opt in they are not immediately alerted about a match that started an hour ago
      // (PROJECT_SPEC.md §6.1).
      suppressed += 1;
      continue;
    }

    const built = buildAlert(
      change.transition,
      {
        match,
        subscriberIds: subscribers,
        observedAt: now,
        previousStartsAtUtc: change.previousStartsAtUtc,
        newStartsAtUtc: change.newStartsAtUtc,
      },
      { timezone: config.timezone },
    );

    const outcome = await options.publisher.publish(
      {
        // Match identity plus the status reached. The same match going LIVE then
        // CANCELLED is two keys; the same transition seen twice is one.
        key: `${key}:${change.transition}`,
        kind: 'ALERT',
        reference: key,
        blocks: built.blocks,
        text: built.text,
        recipientCount: subscribers.length,
      },
      now,
    );

    if (outcome.status === 'sent') alerted += 1;
    else if (outcome.status === 'failed') {
      failed += 1;
      unrecorded.add(key);
    } else suppressed += 1;
  }

  const observed: MatchStateRecord[] = matches
    .filter((match) => !unrecorded.has(matchKey(match.id)))
    .map((match) => ({
      matchKey: matchKey(match.id),
      tournamentKey: tournamentKey(match.id.tournament),
      status: match.status,
      startsAtUtc: match.schedule.startsAtUtc,
      observedAt: now,
    }));

  await options.state.saveMatchStates(observed, now);

  return {
    tournamentsToday: runningToday.length,
    checked: matches.length,
    transitions: changes.length,
    alerted,
    suppressed,
    failed,
    subscribers: subscribers.length,
  };
}
