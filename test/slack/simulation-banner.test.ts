import { describe, expect, it } from 'vitest';

import { blockText } from '../../src/slack/blocks/common.ts';
import { TEST_MARKER, markAsSimulation } from '../../src/slack/blocks/simulation.ts';
import { ACCENTS } from '../../src/slack/blocks/theme.ts';

/**
 * How a drill is marked.
 *
 * The banner has two jobs that pull against each other: nobody must mistake a
 * simulation for real news, and a simulation must still look like the real thing —
 * a rehearsal that looks different from the performance rehearses very little. It
 * resolves as a small leading context line, not a redesign.
 */

const realMessage = {
  blocks: [
    {
      type: 'header' as const,
      text: { type: 'plain_text' as const, text: '🎾 Tennis TV — Today' },
    },
    { type: 'section' as const, text: { type: 'mrkdwn' as const, text: '*10:41* — A vs B' } },
  ],
  text: 'Tennis TV: 1 match today',
  accent: ACCENTS.schedule,
};

describe('the test banner', () => {
  it('marks the message body', () => {
    expect(blockText(markAsSimulation(realMessage).blocks)).toContain(TEST_MARKER);
  });

  it('marks the notification fallback too', () => {
    // Someone who only sees the notification must know it is a drill.
    expect(markAsSimulation(realMessage).text).toContain(TEST_MARKER);
  });

  it('leads, so it survives a collapsed preview', () => {
    const [first] = markAsSimulation(realMessage).blocks;
    expect(blockText([first as never])).toContain(TEST_MARKER);
  });

  it('is a quiet context line, not a header', () => {
    const [first] = markAsSimulation(realMessage).blocks;
    expect(first?.type).toBe('context');
  });

  it('adds exactly one block and changes nothing else', () => {
    const marked = markAsSimulation(realMessage);

    expect(marked.blocks).toHaveLength(realMessage.blocks.length + 1);
    expect(marked.blocks.slice(1)).toEqual(realMessage.blocks);
  });

  it('keeps the accent, so a simulated live alert is still red', () => {
    expect(markAsSimulation({ ...realMessage, accent: ACCENTS.live }).accent).toBe(ACCENTS.live);
  });

  it('says plainly that nothing real will be sent', () => {
    const text = blockText(markAsSimulation(realMessage).blocks);

    expect(text).toContain('Test data');
    expect(text).toContain('no real Tennis TV notification will be sent');
  });

  it('accepts a specific explanation when the caller has one', () => {
    const marked = markAsSimulation(realMessage, 'Simulated LIVE alert');
    expect(blockText(marked.blocks)).toContain('Simulated LIVE alert');
  });
});
