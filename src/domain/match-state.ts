/**
 * The match state machine.
 *
 * Pure, synchronous, and expressed entirely in normalised `MatchStatus` values — it has
 * no idea what the provider called anything. Every alert the bot sends is decided here,
 * which is why this file has no I/O and is exhaustively unit-tested.
 *
 * The full transition matrix is PROJECT_SPEC.md §6.3.
 */

import { isNotifiableTransition, type MatchStatus, type NotifiableTransition } from './types.ts';

/** What we knew about a match before, and what we observe now. */
export interface ObservedState {
  readonly status: MatchStatus;
  /** Published start, or null when Tennis TV has not given one. */
  readonly startsAtUtc: Date | null;
}

export interface StateChange {
  readonly from: MatchStatus;
  readonly to: MatchStatus;
  readonly transition: NotifiableTransition;
  /**
   * The start time before and after, when a delay moved it.
   *
   * Populated only when both are known and actually differ — the alert renders
   * "Original start" / "New time" from these, and says nothing when they are absent
   * rather than inventing a new time (PROJECT_SPEC.md §8).
   */
  readonly previousStartsAtUtc: Date | null;
  readonly newStartsAtUtc: Date | null;
}

export interface TransitionOptions {
  /**
   * How far a published start must move later before it counts as a delay.
   *
   * Guards against announcing a two-minute correction. Comparing two *published*
   * times is not the same as comparing a time to the clock: this reacts to Tennis TV
   * changing its mind, never to time passing (PROJECT_SPEC.md §6.4).
   */
  readonly scheduleSlipMinutes?: number;
}

const DEFAULT_SCHEDULE_SLIP_MINUTES = 15;

/**
 * Decides whether moving from `previous` to `observed` is worth telling people about.
 *
 * The rules, from PROJECT_SPEC.md §6.3:
 *  - LIVE, DELAYED and CANCELLED are notifiable; COMPLETED is not;
 *  - the same status observed again is never a transition, which is what makes a
 *    restart while a match is still live silent;
 *  - UNKNOWN is inert in both directions — an unrecognised provider code must never
 *    look like a cancellation, and recovering from one must not replay a transition
 *    that already happened;
 *  - CANCELLED and COMPLETED are terminal;
 *  - a first sighting only alerts if the match is already LIVE: learning that a match
 *    exists is not news, but one already in play is.
 */
export function detectStateChange(
  previous: ObservedState | null,
  observed: ObservedState,
  options: TransitionOptions = {},
): StateChange | null {
  if (observed.status === 'UNKNOWN') return null;

  if (previous === null) {
    return observed.status === 'LIVE'
      ? change('SCHEDULED', 'LIVE', 'LIVE', null, observed.startsAtUtc)
      : null;
  }

  if (previous.status === 'UNKNOWN') return null;

  // Nothing follows a cancellation or a completion.
  if (previous.status === 'CANCELLED' || previous.status === 'COMPLETED') return null;

  if (previous.status === observed.status) {
    // Not a status change — but the provider may have pushed a still-upcoming match
    // later, which is a delay it never labelled as one.
    return detectScheduleSlip(previous, observed, options);
  }

  if (!isNotifiableTransition(observed.status)) return null;

  return change(
    previous.status,
    observed.status,
    observed.status,
    previous.startsAtUtc,
    observed.startsAtUtc,
  );
}

/**
 * A published start time moving later, while the match is still upcoming.
 *
 * Reconnaissance could not establish how Tennis TV labels a delay
 * (docs/TENNISTV_DATA_SOURCE.md §12), so this covers the case where it simply
 * republishes the match at a later time. Only *later* counts: a match brought forward
 * is not a delay, and a `Time TBC` match has nothing to compare.
 */
function detectScheduleSlip(
  previous: ObservedState,
  observed: ObservedState,
  options: TransitionOptions,
): StateChange | null {
  if (previous.status !== 'SCHEDULED') return null;
  if (previous.startsAtUtc === null || observed.startsAtUtc === null) return null;

  const slipMs = (options.scheduleSlipMinutes ?? DEFAULT_SCHEDULE_SLIP_MINUTES) * 60_000;
  const moved = observed.startsAtUtc.getTime() - previous.startsAtUtc.getTime();

  if (moved < slipMs) return null;

  return change('SCHEDULED', 'DELAYED', 'DELAYED', previous.startsAtUtc, observed.startsAtUtc);
}

const change = (
  from: MatchStatus,
  to: MatchStatus,
  transition: NotifiableTransition,
  previousStartsAtUtc: Date | null,
  newStartsAtUtc: Date | null,
): StateChange => ({ from, to, transition, previousStartsAtUtc, newStartsAtUtc });

/**
 * Whether a status means the match is still ahead of us, and therefore still worth
 * polling. Used by the monitor to decide when a tournament has gone quiet.
 */
export function isPending(status: MatchStatus): boolean {
  switch (status) {
    case 'SCHEDULED':
    case 'DELAYED':
    case 'LIVE':
      return true;
    case 'CANCELLED':
    case 'COMPLETED':
      return false;
    case 'UNKNOWN':
      // Unknown is not evidence that a match has finished, so keep watching it.
      return true;
  }
}
