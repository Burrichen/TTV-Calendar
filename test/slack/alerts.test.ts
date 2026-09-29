import { describe, expect, it } from 'vitest';

import {
  NoRecipientsError,
  buildAlert,
  buildCancelledAlert,
  buildDelayedAlert,
  buildLiveAlert,
} from '../../src/slack/blocks/alerts.ts';
import { blockText } from '../../src/slack/blocks/common.ts';
import { ACCENTS } from '../../src/slack/blocks/theme.ts';
import {
  buildErrorResponse,
  buildSubscriptionConfirmation,
} from '../../src/slack/blocks/diagnostics.ts';
import type { Match } from '../../src/domain/types.ts';

const OPTIONS = { timezone: 'Europe/London' };
const OBSERVED = new Date('2026-08-15T18:04:00Z');

const aMatch = (overrides: Partial<Match> = {}): Match => ({
  id: {
    tournament: { providerTournamentId: '1', year: 2026 },
    providerMatchId: 'MS001',
  },
  tournamentName: 'ATP Cincinnati',
  sideOne: { name: 'Sinner', isKnown: true },
  sideTwo: { name: 'Alcaraz', isKnown: true },
  schedule: {
    onDate: '2026-08-15',
    startsAtUtc: new Date('2026-08-15T18:04:00Z'),
    notBeforeUtc: null,
    tbcReason: null,
  },
  status: 'LIVE',
  rawStatus: { primary: 'P', secondary: 'L', reason: null, unmapped: true },
  round: 'Semi-final',
  court: 'Centre Court',
  isShownOnTennisTv: true,
  isSimulated: false,
  ...overrides,
});

const view = (overrides: Record<string, unknown> = {}) => ({
  match: aMatch(),
  subscriberIds: ['U123ABC', 'U456DEF'],
  observedAt: OBSERVED,
  ...overrides,
});

describe('live alert', () => {
  it('matches the specified shape', () => {
    const text = blockText(buildLiveAlert(view(), OPTIONS).blocks);

    // Status on its own line, players emphasised beneath it.
    expect(text).toContain('🔴 *LIVE*');
    expect(text).toContain('*Sinner vs Alcaraz*');
    expect(text).toContain('ATP Cincinnati');
    expect(text).toContain('Started 19:04 UK');
    expect(text).toContain('<@U123ABC> <@U456DEF>');
  });

  it('mentions exactly the users supplied, in order', () => {
    const message = buildLiveAlert(view({ subscriberIds: ['U1', 'U2', 'U3'] }), OPTIONS);
    expect(blockText(message.blocks)).toContain('<@U1> <@U2> <@U3>');
  });

  it('falls back to the observed time when no start time was published', () => {
    const match = aMatch({
      schedule: {
        onDate: '2026-08-15',
        startsAtUtc: null,
        notBeforeUtc: null,
        tbcReason: 'NOT_PUBLISHED',
      },
    });

    expect(blockText(buildLiveAlert(view({ match }), OPTIONS).blocks)).toContain(
      'Started 19:04 UK',
    );
  });

  it('includes round and court as context when known', () => {
    expect(blockText(buildLiveAlert(view(), OPTIONS).blocks)).toContain(
      'Semi-final · Centre Court',
    );
  });
});

describe('delayed alert', () => {
  it('states the original start, and the provider reason when there is one', () => {
    const text = blockText(buildDelayedAlert(view({ reason: 'Rain' }), OPTIONS).blocks);

    expect(text).toContain('⏸️ *DELAYED*');
    expect(text).toContain('*Sinner vs Alcaraz*');
    expect(text).toContain('Original start: 19:04 UK');
    expect(text).toContain('Rain');
  });

  it('states a new time when Tennis TV has republished one', () => {
    const text = blockText(
      buildDelayedAlert(
        view({
          previousStartsAtUtc: new Date('2026-08-15T18:00:00Z'),
          newStartsAtUtc: new Date('2026-08-15T19:00:00Z'),
        }),
        OPTIONS,
      ).blocks,
    );

    expect(text).toContain('Original start: 19:00 UK');
    expect(text).toContain('New time: 20:00 UK');
  });

  it('offers no new time when Tennis TV has not published one', () => {
    // Never invent a replacement time (PROJECT_SPEC.md §8).
    const text = blockText(buildDelayedAlert(view(), OPTIONS).blocks);

    expect(text).not.toContain('New time');
    expect(text).not.toMatch(/rescheduled/i);
  });
});

describe('cancellation alert', () => {
  it('states the cancellation plainly, as specified', () => {
    const text = blockText(buildCancelledAlert(view({ reason: 'Walkover' }), OPTIONS).blocks);

    expect(text).toContain('❌ *CANCELLED*');
    expect(text).toContain('*Sinner vs Alcaraz*');
    expect(text).toContain('ATP Cincinnati');
    expect(text).toContain('<@U123ABC> <@U456DEF>');
    // The provider's reason is small print, not part of the specified body.
    expect(text).toContain('Walkover');
  });
});

describe('every alert', () => {
  const transitions = ['LIVE', 'DELAYED', 'CANCELLED'] as const;

  it.each(transitions)('refuses to build a %s alert with no subscribers', (transition) => {
    // PROJECT_SPEC.md §6.1: if nobody is opted in, post nothing at all.
    expect(() => buildAlert(transition, view({ subscriberIds: [] }), OPTIONS)).toThrow(
      NoRecipientsError,
    );
  });

  it.each(transitions)('%s never contains a mass mention', (transition) => {
    const message = buildAlert(transition, view(), OPTIONS);
    const text = `${blockText(message.blocks)}\n${message.text}`;

    for (const token of ['@channel', '@here', '@everyone']) {
      expect(text).not.toContain(token);
    }
  });

  it.each(transitions)('%s has a plain-text fallback', (transition) => {
    expect(buildAlert(transition, view(), OPTIONS).text.length).toBeGreaterThan(0);
  });

  it.each(transitions)('%s escapes externally sourced names', (transition) => {
    const match = aMatch({ sideOne: { name: '<b>x</b>', isKnown: true } });
    const text = blockText(buildAlert(transition, view({ match }), OPTIONS).blocks);

    expect(text).toContain('&lt;b&gt;');
    expect(text).not.toContain('<b>');
  });
});

describe('ephemeral responses', () => {
  describe('subscription confirmation', () => {
    it('confirms a new opt-in, and says what will happen', () => {
      const text = blockText(buildSubscriptionConfirmation(true, true).blocks);
      expect(text).toContain("You're opted in");
      // Names where the mention will appear, so nobody expects a DM.
      expect(text).toContain('@mentioned here');
    });

    it('is honest when a repeat click changed nothing', () => {
      expect(blockText(buildSubscriptionConfirmation(true, false).blocks)).toContain(
        'already opted in',
      );
      expect(blockText(buildSubscriptionConfirmation(false, false).blocks)).toContain(
        'already opted out',
      );
    });

    it('reassures that summaries continue after opting out', () => {
      expect(blockText(buildSubscriptionConfirmation(false, true).blocks)).toContain(
        'Scheduled summaries still post',
      );
    });

    it('never reads as an error', () => {
      for (const [active, changed] of [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ] as const) {
        const text = blockText(buildSubscriptionConfirmation(active, changed).blocks);
        expect(text).not.toMatch(/error|failed|sorry/i);
      }
    });
  });

  it('builds an error response without leaking a stack trace', () => {
    const message = buildErrorResponse('Could not update your preference.', 'x'.repeat(1000));
    const text = blockText(message.blocks);

    expect(text).toContain('⚠️');
    expect(text).toContain('Could not update your preference.');
    expect(text.length).toBeLessThan(600);
  });
});

describe('alert presentation', () => {
  /**
   * An alert interrupts people mid-task, so it earns its space by being short. These
   * pin the things that keep it that way, and the accent that tells LIVE from
   * CANCELLED before a word is read.
   */

  it.each([
    ['LIVE', ACCENTS.live],
    ['DELAYED', ACCENTS.delayed],
    ['CANCELLED', ACCENTS.cancelled],
  ] as const)('%s carries its own accent colour', (transition, accent) => {
    expect(buildAlert(transition, view(), OPTIONS).accent).toBe(accent);
  });

  it('gives each status a distinct colour', () => {
    const accents = new Set([ACCENTS.live, ACCENTS.delayed, ACCENTS.cancelled]);
    expect(accents.size).toBe(3);
  });

  it.each(['LIVE', 'DELAYED', 'CANCELLED'] as const)('%s stays compact', (transition) => {
    // Body, optional small print, mentions. Nothing else earns a block here.
    expect(buildAlert(transition, view(), OPTIONS).blocks.length).toBeLessThanOrEqual(3);
  });

  it.each(['LIVE', 'DELAYED', 'CANCELLED'] as const)(
    '%s carries no buttons — an alert is not a menu',
    (transition) => {
      const blocks = buildAlert(transition, view(), OPTIONS).blocks;
      expect(blocks.some((block) => block.type === 'actions')).toBe(false);
    },
  );

  it.each(['LIVE', 'DELAYED', 'CANCELLED'] as const)(
    '%s says what happened in words, not only colour',
    (transition) => {
      // Colour is never the sole carrier: this has to survive a screen reader.
      expect(buildAlert(transition, view(), OPTIONS).text).toContain(transition);
    },
  );

  it('names the tournament in the fallback, so a notification stands alone', () => {
    expect(buildLiveAlert(view(), OPTIONS).text).toContain('ATP Cincinnati');
  });

  it('puts the mentions last, after the detail', () => {
    const blocks = buildLiveAlert(view(), OPTIONS).blocks;
    const last = blocks.at(-1);

    expect(last).toBeDefined();
    expect(blockText(last === undefined ? [] : [last])).toContain('<@U123ABC>');
  });

  it('stays compact with twenty subscribers', () => {
    const many = Array.from({ length: 20 }, (_, index) => `U${String(index)}`);
    const message = buildLiveAlert(view({ subscriberIds: many }), OPTIONS);

    expect(message.blocks.length).toBeLessThanOrEqual(3);
    expect(blockText(message.blocks)).toContain('<@U19>');
  });
});
