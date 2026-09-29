/**
 * Accent colours for the coloured bar down the left of a message.
 *
 * Slack draws that bar from an attachment's `color`, which is the only reason these
 * messages are posted as a single attachment rather than as top-level blocks. The bar
 * is what makes a schedule recognisable at a glance in a busy channel, and what
 * separates "here is the week" from "a match just went live".
 *
 * Colour is never the only signal: every message also carries a word and an emoji, so
 * the meaning survives colour blindness, a screen reader, and a plain-text client.
 */

export const ACCENTS = {
  /** Tennis-ball lime. Daily, weekly and monthly schedules. */
  schedule: '#C3E82D',
  /** A match is on now. */
  live: '#E01E5A',
  /** Pushed back. Amber rather than red: it is a change, not a loss. */
  delayed: '#ECB22E',
  /** Not happening. Muted rather than alarming — nothing needs doing. */
  cancelled: '#8D8D8D',
} as const;

export type Accent = (typeof ACCENTS)[keyof typeof ACCENTS];
