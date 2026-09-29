/**
 * Provider status codes → normalised `MatchStatus`.
 *
 * This table is Tennis TV knowledge and lives strictly inside the provider boundary
 * (ARCHITECTURE.md §15). It is built from OBSERVED data, not from the constants
 * declared in Tennis TV's front-end bundle — the two are known to disagree
 * (TENNISTV_DATA_SOURCE.md §9).
 *
 * Verified on 2026-09-14 across 1868 matches:
 *   Status:      F (1400), Finished (431), CA (27), WO (9), absent (1)
 *   PulseStatus: C (1436), U (432)
 *
 * The in-play codes below are declared by the front end but were NOT observed, because
 * nothing was in play on the capture date. They are mapped optimistically because
 * mapping them to UNKNOWN would suppress the live alerts the bot exists to send; the
 * `unmapped` flag on the result records which ones we are relying on unverified.
 */

import type { MatchStatus, RawStatus } from '../domain/types.ts';

/** The provider's `Status` field. Case is preserved exactly as observed. */
const PRIMARY_STATUS: Readonly<Record<string, MatchStatus>> = {
  // --- verified against captured data ---
  F: 'COMPLETED',
  Finished: 'COMPLETED',
  CA: 'CANCELLED',
  WO: 'CANCELLED', // walkover: the match will not be played
  // --- declared by the front end, not yet observed (see file header) ---
  U: 'SCHEDULED',
  C: 'LIVE', // on court
  W: 'LIVE', // warm-up
  P: 'LIVE', // playing
  D: 'LIVE', // toilet break
  M: 'LIVE', // medical timeout
  R: 'LIVE', // challenge in progress
  E: 'LIVE', // correction mode
  S: 'DELAYED', // suspended
  L: 'CANCELLED',
};

/** The provider's `PulseStatus` field — which representation a record is. */
const SECONDARY_STATUS: Readonly<Record<string, MatchStatus>> = {
  U: 'SCHEDULED',
  L: 'LIVE',
  C: 'COMPLETED',
};

/** Codes we accept from the primary field without having seen them in data. */
const UNVERIFIED_PRIMARY = new Set(['U', 'C', 'W', 'P', 'D', 'M', 'R', 'E', 'S', 'L']);

export interface RawStatusInput {
  readonly primary?: string | null | undefined;
  readonly secondary?: string | null | undefined;
  readonly reason?: string | null | undefined;
}

export interface MappedStatus {
  readonly status: MatchStatus;
  readonly rawStatus: RawStatus;
}

/**
 * Maps the provider's status fields to a normalised status, retaining the originals.
 *
 * Precedence is deliberate. `Status` is the truthful field; `PulseStatus` says which
 * representation the record is and can disagree — 431 records carried
 * `Status: "Finished"` with `PulseStatus: "U"`. Reading `PulseStatus` first would have
 * called every one of those matches upcoming.
 *
 * An unrecognised primary code does NOT fall through to the secondary field, because
 * that would let an unfamiliar code be reported as a confident state. It becomes
 * UNKNOWN, flagged `unmapped`, and the caller emits no transition for it.
 */
export function mapStatus(input: RawStatusInput): MappedStatus {
  const primary = normalise(input.primary);
  const secondary = normalise(input.secondary);
  const reason = normalise(input.reason);

  const raw = (unmapped: boolean): RawStatus => ({ primary, secondary, reason, unmapped });

  if (primary !== null) {
    const mapped = PRIMARY_STATUS[primary];
    if (mapped !== undefined) {
      return { status: mapped, rawStatus: raw(UNVERIFIED_PRIMARY.has(primary)) };
    }
    return { status: 'UNKNOWN', rawStatus: raw(true) };
  }

  // `Status` absent — observed once in 1868 records. Fall back to the representation.
  if (secondary !== null) {
    const mapped = SECONDARY_STATUS[secondary];
    if (mapped !== undefined) return { status: mapped, rawStatus: raw(false) };
  }

  return { status: 'UNKNOWN', rawStatus: raw(true) };
}

function normalise(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
