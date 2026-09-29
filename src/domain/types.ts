/**
 * The vocabulary the rest of the application speaks.
 *
 * Nothing here knows that Tennis TV exists. No provider field name (`MatchId`,
 * `PulseStatus`, `NotBeforeISOTime`, `notShown`) appears in this file or in anything
 * that imports it — see ARCHITECTURE.md §2.1 and §15.
 */

/**
 * Identity of a tournament.
 *
 * Composite because the provider reuses a tournament id every year — Wimbledon is
 * `540` in 1877 and in 2026 (TENNISTV_DATA_SOURCE.md §5).
 */
export interface TournamentId {
  readonly providerTournamentId: string;
  readonly year: number;
}

/**
 * Identity of a match.
 *
 * Composite because the provider's match id is NOT globally unique — `MS011`, `MS021`
 * and `MS031` were each observed in more than one tournament. Identity must never be
 * built on scheduled start time, which moves.
 */
export interface MatchId {
  readonly tournament: TournamentId;
  readonly providerMatchId: string;
}

export const tournamentKey = (id: TournamentId): string => `${id.providerTournamentId}:${id.year}`;

export const matchKey = (id: MatchId): string =>
  `${tournamentKey(id.tournament)}:${id.providerMatchId}`;

/**
 * Normalised match state.
 *
 * The provider's raw status vocabulary is wider, inconsistent between its two record
 * shapes, and known to be incomplete (TENNISTV_DATA_SOURCE.md §9). Everything above
 * the provider boundary uses these six values only.
 */
export const MATCH_STATUSES = [
  'SCHEDULED',
  'DELAYED',
  'LIVE',
  'CANCELLED',
  'COMPLETED',
  'UNKNOWN',
] as const;

export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const isMatchStatus = (value: unknown): value is MatchStatus =>
  typeof value === 'string' && (MATCH_STATUSES as readonly string[]).includes(value);

/**
 * What the provider actually said, kept alongside the normalised status so a mapping
 * problem can be investigated without re-fetching or guessing.
 *
 * PROJECT_SPEC.md requires that we never discard this: when an unrecognised code
 * appears, `status` is `UNKNOWN` and these fields say exactly what produced it.
 */
export interface RawStatus {
  /** The provider's primary status field, verbatim. May be absent — 1 in 1868 was. */
  readonly primary: string | null;
  /** The provider's secondary/representation status field, verbatim. */
  readonly secondary: string | null;
  /** The provider's reason qualifier (e.g. retirement, walkover), verbatim. */
  readonly reason: string | null;
  /** True when nothing in the mapping table matched, so `status` fell back to UNKNOWN. */
  readonly unmapped: boolean;
}

/**
 * A scheduled start.
 *
 * `startsAtUtc === null` means the time is genuinely not published. There is no
 * sentinel timestamp, so a guess is not representable (PROJECT_SPEC.md §8).
 * `onDate` is still known in that case, which is what day-bucketing uses.
 */
export interface MatchSchedule {
  /** Local calendar date at the venue, `YYYY-MM-DD`. Always known. */
  readonly onDate: string;
  /** Absolute instant, or null when the start time is not published. */
  readonly startsAtUtc: Date | null;
  /**
   * An "earliest possible"/"follows" time the provider offered but which is not a
   * committed start. Never promoted to `startsAtUtc`; available as display context.
   */
  readonly notBeforeUtc: Date | null;
  /** Why the start time is unknown, when it is. */
  readonly tbcReason: TbcReason | null;
}

export type TbcReason =
  'NOT_PUBLISHED' | 'FOLLOWS_PREVIOUS_MATCH' | 'NOT_BEFORE_ONLY' | 'NO_VENUE_OFFSET';

export const isTimeTbc = (schedule: MatchSchedule): boolean => schedule.startsAtUtc === null;

export interface Tournament {
  readonly id: TournamentId;
  readonly name: string;
  /** Country or region as the provider reports it; absent for some tournaments. */
  readonly location: string | null;
  readonly city: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  /** Minutes east of UTC at the venue, from the provider. Null when not supplied. */
  readonly venueUtcOffsetMinutes: number | null;
  /**
   * False only when the provider explicitly marks the tournament unavailable.
   * Absence of a marker means shown (PROJECT_SPEC.md §9).
   */
  readonly isShownOnTennisTv: boolean;
  /** The provider's own words for why it is not shown, when it says so. */
  readonly notShownReason: string | null;
  /** Absolute URL to the tournament on the provider's site, when known. */
  readonly sourceUrl: string | null;
  /**
   * Whether match-level data exists for this tournament yet. Tournaments are published
   * months ahead; matches only once the draw is out (TENNISTV_DATA_SOURCE.md §7).
   */
  readonly hasPublishedMatches: boolean;
  /**
   * True only for records the simulation system created.
   *
   * Simulated records share the production tables so that a simulation exercises the
   * real code path, and this flag is the boundary that keeps them out of real
   * summaries and real alerts (PROJECT_SPEC.md §12).
   */
  readonly isSimulated: boolean;
}

export interface Competitor {
  readonly name: string;
  /** False when the provider is holding a slot for an as-yet-undecided opponent. */
  readonly isKnown: boolean;
}

export interface Match {
  readonly id: MatchId;
  readonly tournamentName: string;
  readonly sideOne: Competitor;
  readonly sideTwo: Competitor;
  readonly schedule: MatchSchedule;
  readonly status: MatchStatus;
  readonly rawStatus: RawStatus;
  readonly round: string | null;
  readonly court: string | null;
  /** Inherited from the tournament unless the provider marks the match itself. */
  readonly isShownOnTennisTv: boolean;
  /** True only for records the simulation system created. */
  readonly isSimulated: boolean;
}

/** A Slack user's opt-in to live alerts, scoped to the workspace and channel. */
export interface SlackSubscription {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly isActive: boolean;
  readonly subscribedAt: Date | null;
  readonly unsubscribedAt: Date | null;
  readonly updatedAt: Date;
}

/** The state transitions the bot notifies on (PROJECT_SPEC.md §6). */
export const NOTIFIABLE_TRANSITIONS = ['LIVE', 'DELAYED', 'CANCELLED'] as const;
export type NotifiableTransition = (typeof NOTIFIABLE_TRANSITIONS)[number];

export const isNotifiableTransition = (status: MatchStatus): status is NotifiableTransition =>
  (NOTIFIABLE_TRANSITIONS as readonly MatchStatus[]).includes(status);

export type NotificationStatus = 'PENDING' | 'SENT' | 'SUPPRESSED' | 'ABANDONED';

/**
 * One outbound notification, claimed before it is sent so that a crash loses a message
 * rather than duplicating one (ARCHITECTURE.md §8.2).
 */
export interface NotificationEvent {
  readonly id: number;
  /** Deterministic, derived from meaning — never from a timestamp or a random id. */
  readonly idempotencyKey: string;
  readonly kind: 'MATCH_TRANSITION' | 'SUMMARY';
  readonly match: MatchId | null;
  readonly transition: NotifiableTransition | null;
  readonly fromStatus: MatchStatus | null;
  readonly toStatus: MatchStatus | null;
  readonly status: NotificationStatus;
  readonly channelId: string | null;
  readonly slackMessageTs: string | null;
  readonly recipientCount: number | null;
  readonly detail: string | null;
  readonly claimedAt: Date;
  readonly settledAt: Date | null;
}

export type SummaryKind = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type SummaryOutcome = 'POSTED' | 'SKIPPED_EMPTY' | 'FAILED';

/**
 * One firing of a scheduled summary, identified by its local occurrence date so a
 * restart or a double trigger resolves to the same row (ARCHITECTURE.md §8.1).
 */
export interface ScheduledSummaryRun {
  readonly id: number;
  readonly kind: SummaryKind;
  /** Local calendar date of the occurrence, `YYYY-MM-DD` in APP_TIMEZONE. */
  readonly occurrenceDate: string;
  readonly status: 'RUNNING' | 'COMPLETE' | 'FAILED';
  readonly outcome: SummaryOutcome | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly detail: string | null;
}

export type SyncKind = 'TOURNAMENTS' | 'MATCHES';
export type SyncStatus = 'RUNNING' | 'SUCCESS' | 'FAILURE';

/** One attempt to pull data from the provider. Drives the health check's freshness. */
export interface SourceSyncRun {
  readonly id: number;
  readonly kind: SyncKind;
  readonly status: SyncStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly tournamentsSeen: number;
  readonly matchesSeen: number;
  readonly error: string | null;
  /** A stable classification of the failure, when there was one. */
  readonly errorCode: string | null;
}
