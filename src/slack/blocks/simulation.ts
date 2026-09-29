/**
 * The marker that distinguishes a simulated message from a real one.
 *
 * Simulations go through the real block builders, the real subscription lookup and the
 * real message service — that is the whole point, since a simulation that avoids the
 * production path tests nothing. The only difference is this banner, so nobody in the
 * channel mistakes a drill for the real thing.
 */

import type { KnownBlock } from '@slack/types';

import type { BuiltMessage } from './common.ts';
import { NAVIGATION_BLOCK_ID, TEST_VARIANT } from './navigation.ts';

export const TEST_MARKER = '🧪 TEST';

/**
 * Wraps a real message in the test banner, changing nothing else.
 *
 * Deliberately a small context line above the message rather than anything louder: a
 * drill should look almost exactly like the real thing, because a rehearsal that looks
 * different from the performance does not rehearse much. It leads, so the marker is
 * the first thing read and survives the collapsed preview, and the fallback carries it
 * too so a notification is marked as clearly as the body.
 *
 * The accent is preserved, so a simulated live alert is still red.
 */
export function markAsSimulation(message: BuiltMessage, detail?: string): BuiltMessage {
  const banner: KnownBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          detail === undefined
            ? `${TEST_MARKER} Test data · no real Tennis TV notification will be sent`
            : `${TEST_MARKER} ${detail}`,
      },
    ],
  };

  return {
    ...message,
    blocks: [banner, ...message.blocks.map(asTestNavigation)],
    text: `${TEST_MARKER} ${message.text}`,
  };
}

/**
 * Points a drill's calendar buttons at the drill's own snapshots.
 *
 * Done here rather than in the builders because "this whole message is a simulation" is
 * exactly what this module knows and they do not — and doing it in one place means a
 * new navigation button cannot forget to be marked.
 */
function asTestNavigation(block: KnownBlock): KnownBlock {
  if (block.type !== 'actions' || block.block_id !== NAVIGATION_BLOCK_ID) return block;

  return {
    ...block,
    elements: block.elements.map((element) =>
      element.type === 'button' ? { ...element, value: TEST_VARIANT } : element,
    ),
  };
}
