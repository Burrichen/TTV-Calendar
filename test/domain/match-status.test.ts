import { describe, expect, it } from 'vitest';

import { mapStatus } from '../../src/tennistv/status-map.ts';
import { MATCH_STATUSES, isMatchStatus } from '../../src/domain/types.ts';

/**
 * Status mapping, tested against the values reconnaissance actually observed
 * (docs/TENNISTV_DATA_SOURCE.md §9) rather than the ones Tennis TV's front-end bundle
 * declares — the two are known to disagree.
 */

describe('mapStatus', () => {
  describe('values verified in captured data', () => {
    it.each([
      ['F', 'COMPLETED'],
      ['Finished', 'COMPLETED'],
      ['CA', 'CANCELLED'],
      ['WO', 'CANCELLED'],
    ] as const)('maps %s to %s', (primary, expected) => {
      const result = mapStatus({ primary, secondary: 'C' });
      expect(result.status).toBe(expected);
      expect(result.rawStatus.unmapped).toBe(false);
    });

    it('treats a walkover as cancelled and keeps the reason', () => {
      const result = mapStatus({ primary: 'WO', secondary: 'C', reason: 'W/O' });
      expect(result.status).toBe('CANCELLED');
      expect(result.rawStatus.reason).toBe('W/O');
    });

    it('treats a retirement as completed — the match was played', () => {
      const result = mapStatus({ primary: 'F', secondary: 'C', reason: 'RET' });
      expect(result.status).toBe('COMPLETED');
      expect(result.rawStatus.reason).toBe('RET');
    });
  });

  describe('primary status wins over the representation field', () => {
    it('does not call a finished match upcoming', () => {
      // 431 of 1868 observed records carried Status "Finished" with PulseStatus "U".
      // Reading the representation field first would mis-report every one of them.
      const result = mapStatus({ primary: 'Finished', secondary: 'U' });
      expect(result.status).toBe('COMPLETED');
    });

    it('records both fields verbatim even when they disagree', () => {
      const result = mapStatus({ primary: 'Finished', secondary: 'U' });
      expect(result.rawStatus.primary).toBe('Finished');
      expect(result.rawStatus.secondary).toBe('U');
    });
  });

  describe('missing primary status', () => {
    it('falls back to the representation field', () => {
      // Observed once in 1868 records: an order-of-play row with no Status at all.
      const result = mapStatus({ secondary: 'U' });
      expect(result.status).toBe('SCHEDULED');
      expect(result.rawStatus.unmapped).toBe(false);
      expect(result.rawStatus.primary).toBeNull();
    });

    it.each([undefined, null, '', '   '])('treats %p as absent', (primary) => {
      expect(mapStatus({ primary, secondary: 'C' }).status).toBe('COMPLETED');
    });

    it('is UNKNOWN when neither field is usable', () => {
      const result = mapStatus({});
      expect(result.status).toBe('UNKNOWN');
      expect(result.rawStatus.unmapped).toBe(true);
    });
  });

  describe('unrecognised codes', () => {
    it('maps to UNKNOWN rather than guessing', () => {
      const result = mapStatus({ primary: 'ZZ', secondary: 'C' });
      expect(result.status).toBe('UNKNOWN');
      expect(result.rawStatus.unmapped).toBe(true);
    });

    it('never falls through to the representation field', () => {
      // Falling back to PulseStatus here would report a confident COMPLETED for a code
      // we do not understand. An unfamiliar code must never look like a real state.
      expect(mapStatus({ primary: 'ZZ', secondary: 'C' }).status).not.toBe('COMPLETED');
    });

    it('retains the unrecognised code so the mapping can be fixed', () => {
      const result = mapStatus({ primary: 'XYZ', secondary: 'Q', reason: 'HUH' });
      expect(result.rawStatus).toEqual({
        primary: 'XYZ',
        secondary: 'Q',
        reason: 'HUH',
        unmapped: true,
      });
    });
  });

  describe('in-play codes', () => {
    it.each(['C', 'W', 'P', 'D', 'M', 'R', 'E'])('maps %s to LIVE', (primary) => {
      expect(mapStatus({ primary }).status).toBe('LIVE');
    });

    it('maps suspension to DELAYED', () => {
      expect(mapStatus({ primary: 'S' }).status).toBe('DELAYED');
    });

    it('flags these as unverified, because none was observed in captured data', () => {
      // Nothing was in play on the capture date. The mapping is a considered guess and
      // says so, so a live run can be audited against reality.
      expect(mapStatus({ primary: 'P' }).rawStatus.unmapped).toBe(true);
      expect(mapStatus({ primary: 'S' }).rawStatus.unmapped).toBe(true);
    });
  });

  it('only ever produces a known status', () => {
    const inputs = ['F', 'Finished', 'CA', 'WO', 'U', 'C', 'S', 'ZZ', ''];
    for (const primary of inputs) {
      const { status } = mapStatus({ primary });
      expect(isMatchStatus(status)).toBe(true);
      expect(MATCH_STATUSES).toContain(status);
    }
  });
});
