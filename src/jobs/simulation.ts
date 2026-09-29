/**
 * Manual testing, without waiting for a real match.
 *
 * The rule from PROJECT_SPEC.md §12 is that a simulation must exercise the *real* path
 * — real Block Kit builders, real subscriber lookup, real mention rendering, real
 * posting — while being unable to corrupt production state. Three things enforce that:
 *
 *  - every simulated message carries a `sim:` idempotency key including a timestamp, so
 *    it can never consume a real report key or a real alert key, and can be run twice;
 *  - simulations never write `match_state`, so a fabricated match cannot become the
 *    "previous state" a later real run compares against;
 *  - every message is banner-marked `🧪 TEST` by the publisher, not by this module, so
 *    the marking cannot be forgotten at a call site.
 *
 * What is deliberately NOT faked: who is opted in. A simulation with nobody subscribed
 * posts nothing, exactly as production does — which makes "did my opt-in work?" a
 * question this can answer.
 */

import { DateTime } from 'luxon';

import type { Config } from '../config/env.ts';
import type { Match, MatchStatus, NotifiableTransition, SummaryKind } from '../domain/types.ts';
import type { Logger } from '../logging/types.ts';
import { occurrenceFor } from '../schedule/occurrences.ts';
import { buildAlert } from '../slack/blocks/alerts.ts';
import type { SlackPublisher } from '../slack/publisher.ts';
import type { StateApi } from '../state/client.ts';
import type { TennisTvProvider } from '../tennistv/provider.ts';
import { runMorning } from './morning.ts';

export const SIMULATION_KINDS = [
  'daily',
  'weekly',
  'monthly',
  'live',
  'delayed',
  'cancelled',
] as const;

export type SimulationKind = (typeof SIMULATION_KINDS)[number];

export const isSimulationKind = (value: string): value is SimulationKind =>
  (SIMULATION_KINDS as readonly string[]).includes(value);

export interface SimulationOptions {
  readonly provider: TennisTvProvider;
  readonly publisher: SlackPublisher;
  readonly state: StateApi;
  readonly config: Config;
  readonly logger: Logger;
  readonly now: Date;
}

export interface SimulationResult {
  readonly kind: SimulationKind;
  readonly posted: boolean;
  /** A sentence explaining what happened, written for whoever triggered the run. */
  readonly detail: string;
}

export async function runSimulation(
  kind: SimulationKind,
  options: SimulationOptions,
): Promise<SimulationResult> {
  options.logger.info({ kind }, 'running simulation');

  return kind === 'daily' || kind === 'weekly' || kind === 'monthly'
    ? simulateReport(kind, options)
    : simulateAlert(kind, options);
}

/**
 * Renders a real report from real Tennis TV data, banner-marked and freshly keyed.
 *
 * `force` bypasses the "is it due, and has it been sent" question entirely, so a
 * preview works at any hour of any day without disturbing the real report's key.
 */
async function simulateReport(
  kind: SimulationKind,
  options: SimulationOptions,
): Promise<SimulationResult> {
  const summaryKind = kind.toUpperCase() as SummaryKind;
  const occurrence = occurrenceFor(summaryKind, options.now, {
    timezone: options.config.timezone,
    hour: options.config.summaryHour,
  });

  const result = await runMorning({
    provider: options.provider,
    publisher: options.publisher,
    state: options.state,
    config: options.config,
    logger: options.logger,
    now: options.now,
    simulated: true,
    // Bypasses both "is it due" and "has it been sent", so a preview works at any hour.
    force: [occurrence],
  });

  if (result.posted > 0) {
    return { kind, posted: true, detail: `Posted a simulated ${kind} report to the channel.` };
  }

  if (options.config.slack.dryRun) {
    // A dry run is a success, not a failure: everything ran except the send.
    return {
      kind,
      posted: false,
      detail:
        `Dry run — the ${kind} report was built and checked, and logged above instead ` +
        'of being posted. Re-run with "Log the message instead of posting it" unticked ' +
        'to send it for real.',
    };
  }

  if (kind === 'daily') {
    return {
      kind,
      posted: false,
      detail:
        'Nothing posted — there are no Tennis TV matches today, which is exactly what ' +
        'the real daily report would do. Try the weekly or monthly simulation instead.',
    };
  }

  return {
    kind,
    posted: false,
    detail: `Nothing posted — the ${kind} report could not be sent. Check the log above.`,
  };
}

/**
 * Posts a real live/delayed/cancelled alert for a fabricated match.
 *
 * Subscribers are looked up for real, so this doubles as the check that opting in
 * worked: with nobody opted in it posts nothing, exactly as production does.
 */
async function simulateAlert(
  kind: SimulationKind,
  options: SimulationOptions,
): Promise<SimulationResult> {
  const transition = kind.toUpperCase() as NotifiableTransition;
  const subscribers = await options.state.subscribers(options.publisher.channelId);

  if (subscribers.length === 0) {
    // Not a failure: it is the production rule, demonstrated (PROJECT_SPEC.md §6.1).
    return {
      kind,
      posted: false,
      detail:
        'Nobody is opted in, so no alert was posted — which is the correct production ' +
        'behaviour. Click "🔔 Opt in to live alerts" in Slack, then run this again.',
    };
  }

  const local = DateTime.fromJSDate(options.now, { zone: options.config.timezone });
  const match = fabricateMatch(transition, options.now, local);
  const originalStart = local.minus({ minutes: 45 }).toJSDate();

  const built = buildAlert(
    transition,
    {
      match,
      subscriberIds: subscribers,
      observedAt: options.now,
      previousStartsAtUtc: transition === 'DELAYED' ? originalStart : null,
      newStartsAtUtc: transition === 'DELAYED' ? match.schedule.startsAtUtc : null,
    },
    { timezone: options.config.timezone },
  );

  const outcome = await options.publisher.publish(
    {
      // Timestamped, so it never collides with a real alert key and can be repeated.
      key: `sim:${transition}:${String(options.now.getTime())}`,
      kind: 'ALERT',
      reference: 'simulation',
      blocks: built.blocks,
      text: built.text,
      recipientCount: subscribers.length,
      simulated: true,
    },
    options.now,
  );

  // Deliberately no `saveMatchStates` call: a fabricated match must never become the
  // previous state a real monitor run compares against.

  if (outcome.status === 'sent') {
    return {
      kind,
      posted: true,
      detail:
        `Posted a simulated ${transition} alert mentioning ` +
        `${String(subscribers.length)} subscriber(s). No real match state was changed.`,
    };
  }

  if (outcome.status === 'dry-run') {
    return {
      kind,
      posted: false,
      detail:
        `Dry run — a ${transition} alert for ${String(subscribers.length)} subscriber(s) ` +
        'was built and logged above instead of being posted. Re-run with "Log the ' +
        'message instead of posting it" unticked to send it for real.',
    };
  }

  return {
    kind,
    posted: false,
    detail: `Not posted (${outcome.status}). Check the log above.`,
  };
}

/** An obviously fictional match, so a simulation cannot be mistaken for real news. */
function fabricateMatch(transition: NotifiableTransition, now: Date, local: DateTime): Match {
  const status: MatchStatus = transition;

  return {
    id: {
      tournament: { providerTournamentId: 'SIMULATION', year: local.year },
      providerMatchId: 'SIM001',
    },
    tournamentName: 'Simulation Open (test data)',
    sideOne: { name: 'Test Player A', isKnown: true },
    sideTwo: { name: 'Test Player B', isKnown: true },
    schedule: {
      onDate: local.toISODate() ?? '',
      startsAtUtc: now,
      notBeforeUtc: null,
      tbcReason: null,
    },
    status,
    rawStatus: { primary: 'SIMULATED', secondary: null, reason: null, unmapped: false },
    round: 'Round of 16',
    court: 'Centre Court',
    isShownOnTennisTv: true,
    isSimulated: true,
  };
}
