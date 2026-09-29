import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_SNAPSHOT_MATCHES,
  monthSnapshotKey,
  weekSnapshotKey,
} from '../../src/domain/snapshot.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import { refreshSnapshots } from '../../src/schedule/snapshots.ts';
import { aMatch, aTournament } from '../support/builders.ts';
import { MemoryStateApi } from '../support/memory-state-api.ts';

/**
 * Writing the snapshots the calendar modals read.
 *
 * The rules that matter: a drill never overwrites the real calendar, and a failure here
 * never fails the morning run — the reports are the job, the snapshots are a
 * convenience.
 */

const NOW = new Date('2026-09-29T07:00:00Z');
let state: MemoryStateApi;

const refresh = (
  overrides: Partial<Parameters<typeof refreshSnapshots>[0]> = {},
): ReturnType<typeof refreshSnapshots> =>
  refreshSnapshots({
    state,
    logger: silentLogger(),
    timezone: 'Europe/London',
    now: NOW,
    tournaments: [aTournament({ startsOn: '2026-09-28', endsOn: '2026-10-04' })],
    matches: [aMatch({ onDate: '2026-09-29', startsAtUtc: new Date('2026-09-29T13:00:00Z') })],
    variant: 'LIVE',
    ...overrides,
  });

beforeEach(() => {
  state = new MemoryStateApi();
});

describe('what gets written', () => {
  it('writes the current week and the current month', async () => {
    const result = await refresh();

    expect(result.written).toEqual([weekSnapshotKey(2026, 40), monthSnapshotKey(2026, 9)]);
    expect(result.failed).toBe(0);
  });

  it('uses ISO week numbering, so a New Year week has one key', async () => {
    await refresh({ now: new Date('2026-01-01T08:00:00Z') });

    // 1 January 2026 falls in ISO week 1 of 2026.
    expect([...state.snapshots.keys()].some((key) => key.startsWith('week:2026-W01'))).toBe(true);
  });

  it('includes only the matches inside each period', async () => {
    await refresh({
      matches: [
        aMatch({
          matchId: 'IN',
          onDate: '2026-09-29',
          startsAtUtc: new Date('2026-09-29T13:00:00Z'),
        }),
        aMatch({
          matchId: 'OUT',
          onDate: '2026-11-15',
          startsAtUtc: new Date('2026-11-15T13:00:00Z'),
        }),
      ],
    });

    const week = state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`);
    expect(week?.matches).toHaveLength(1);
    expect(week?.matches[0]?.matchKey).toContain('IN');
  });

  it('reduces a match to what a calendar view shows', async () => {
    await refresh();
    const week = state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`);

    expect(week?.matches[0]).toEqual({
      matchKey: '4713:2026:MS011',
      tournamentName: 'Example Open',
      sideOne: 'Player A',
      sideTwo: 'Player B',
      startsAtUtc: '2026-09-29T13:00:00.000Z',
      onDate: '2026-09-29',
    });
  });

  it('counts each tournament’s matches for the month overview', async () => {
    await refresh({
      matches: [
        aMatch({
          matchId: 'A',
          onDate: '2026-09-29',
          startsAtUtc: new Date('2026-09-29T13:00:00Z'),
        }),
        aMatch({
          matchId: 'B',
          onDate: '2026-09-30',
          startsAtUtc: new Date('2026-09-30T13:00:00Z'),
        }),
      ],
    });

    const month = state.snapshots.get(`${monthSnapshotKey(2026, 9)}|LIVE`);
    expect(month?.tournaments[0]?.matchCount).toBe(2);
  });

  it('records when it was taken, so a view can say how fresh it is', async () => {
    await refresh();
    const week = state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`);

    expect(week?.generatedAt).toBe(NOW.toISOString());
  });

  it('preserves an unpublished start time as null rather than guessing', async () => {
    await refresh({
      matches: [aMatch({ onDate: '2026-09-29', startsAtUtc: null })],
    });

    const week = state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`);
    expect(week?.matches[0]?.startsAtUtc).toBeNull();
  });

  it('caps an implausibly large period rather than writing an unbounded row', async () => {
    const many = Array.from({ length: MAX_SNAPSHOT_MATCHES + 200 }, (_, index) =>
      aMatch({
        matchId: `M${String(index)}`,
        onDate: '2026-09-29',
        startsAtUtc: new Date('2026-09-29T13:00:00Z'),
      }),
    );

    await refresh({ matches: many });

    const week = state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`);
    expect(week?.matches).toHaveLength(MAX_SNAPSHOT_MATCHES);
  });
});

describe('test isolation', () => {
  it('writes a drill under its own key', async () => {
    await refresh({ variant: 'TEST' });

    expect(state.snapshots.has(`${weekSnapshotKey(2026, 40)}|TEST`)).toBe(true);
    expect(state.snapshots.has(`${weekSnapshotKey(2026, 40)}|LIVE`)).toBe(false);
  });

  it('never overwrites the real calendar', async () => {
    await refresh();
    const real = state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`);

    await refresh({ variant: 'TEST', matches: [] });

    expect(state.snapshots.get(`${weekSnapshotKey(2026, 40)}|LIVE`)).toBe(real);
  });
});

describe('failure', () => {
  it('never fails the morning run', async () => {
    state.failOn.add('saveSnapshot');

    const result = await refresh();

    expect(result.failed).toBe(2);
    expect(result.written).toEqual([]);
  });

  it('still writes the month when the week fails', async () => {
    let calls = 0;
    const original = state.saveSnapshot.bind(state);
    state.saveSnapshot = async (snapshot, variant) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return original(snapshot, variant);
    };

    const result = await refresh();

    expect(result.written).toEqual([monthSnapshotKey(2026, 9)]);
    expect(result.failed).toBe(1);
  });
});
