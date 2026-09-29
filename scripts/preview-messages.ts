/**
 * Renders every Slack message design to the terminal.
 *
 *   npm run preview:messages              review the layouts
 *   npm run preview:messages -- --json    write the exact payloads to .preview/
 *
 * Block Kit is hard to judge from a test assertion. This prints an approximation of
 * what lands in the channel — including the coloured accent bar — so the designs can be
 * reviewed, and re-reviewed after a change, without a workspace or a Slack app.
 *
 * `--json` writes each design as the JSON Slack would actually receive, which is what
 * to paste into Block Kit Builder when checking something pixel by pixel.
 *
 * It is a design tool, not a test: nothing here asserts anything.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildAlert } from '../src/slack/blocks/alerts.ts';
import {
  buildErrorResponse,
  buildSubscriptionConfirmation,
} from '../src/slack/blocks/diagnostics.ts';
import {
  buildDailySummary,
  buildMonthlySummary,
  buildWeeklySummary,
  type BuiltMessage,
} from '../src/slack/blocks/summaries.ts';
import { markAsSimulation } from '../src/slack/blocks/simulation.ts';
import { ACCENTS } from '../src/slack/blocks/theme.ts';
import type { Match, Tournament } from '../src/domain/types.ts';

const OPTIONS = { timezone: 'Europe/London' };

/** `--json` writes the payloads here instead of only printing them. */
const WRITE_JSON = process.argv.includes('--json');
const OUT_DIR = join(process.cwd(), '.preview');

if (WRITE_JSON) mkdirSync(OUT_DIR, { recursive: true });

/** Turns `#C3E82D` into an ANSI true-colour escape, so the bar looks like Slack's. */
function ansi(hex: string): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;
}

/** The exact payload the publisher sends, minus the parts Slack fills in. */
function payloadOf(message: BuiltMessage): object {
  return {
    attachments: [
      {
        color: message.accent ?? ACCENTS.schedule,
        fallback: message.text,
        blocks: message.blocks,
      },
    ],
  };
}

// ------------------------------------------------------------------ fixtures

let matchSeq = 0;

const match = (
  tournamentName: string,
  sideOne: string,
  sideTwo: string,
  startsAtUtc: Date | null,
  onDate: string,
): Match => {
  matchSeq += 1;
  return {
    id: {
      tournament: { providerTournamentId: '1', year: 2026 },
      providerMatchId: `M${String(matchSeq)}`,
    },
    tournamentName,
    sideOne: { name: sideOne, isKnown: true },
    sideTwo: { name: sideTwo, isKnown: true },
    schedule: {
      onDate,
      startsAtUtc,
      notBeforeUtc: null,
      tbcReason: startsAtUtc === null ? 'NOT_PUBLISHED' : null,
    },
    status: 'SCHEDULED',
    rawStatus: { primary: 'U', secondary: 'U', reason: null, unmapped: false },
    round: 'Round of 32',
    court: 'Centre Court',
    isShownOnTennisTv: true,
    isSimulated: false,
  };
};

const tournament = (
  name: string,
  startsOn: string,
  endsOn: string,
  city: string,
  route?: string,
): Tournament => ({
  id: { providerTournamentId: name, year: 2026 },
  name,
  location: 'China',
  city,
  startsOn,
  endsOn,
  venueUtcOffsetMinutes: 480,
  isShownOnTennisTv: true,
  notShownReason: null,
  sourceUrl: route === undefined ? null : `https://www.tennistv.com${route}`,
  hasPublishedMatches: false,
  isSimulated: false,
});

// -------------------------------------------------------------------- render

/** A rough approximation of Slack's rendering, good enough to judge a layout by. */
function render(title: string, message: BuiltMessage): void {
  const width = 72;
  const accent = message.accent ?? ACCENTS.schedule;
  // The coloured bar Slack draws down the left of the attachment.
  const bar = `${ansi(accent)}┃\x1b[0m`;

  if (WRITE_JSON) {
    const name = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    writeFileSync(
      join(OUT_DIR, `${name}.json`),
      `${JSON.stringify(payloadOf(message), null, 2)}\n`,
    );
  }

  process.stdout.write(
    `\n\x1b[1m┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 4))}\x1b[0m\n`,
  );

  for (const block of message.blocks) {
    if (block.type === 'header' && 'text' in block) {
      process.stdout.write(`${bar} \x1b[1m${block.text.text}\x1b[0m\n`);
    } else if (block.type === 'section' && block.text !== undefined) {
      for (const line of block.text.text.split('\n')) {
        process.stdout.write(`${bar} ${slackish(line)}\n`);
      }
      process.stdout.write(`${bar}\n`);
    } else if (block.type === 'context' && 'elements' in block) {
      for (const element of block.elements) {
        if ('text' in element && typeof element.text === 'string') {
          process.stdout.write(`${bar} \x1b[2m${slackish(element.text)}\x1b[0m\n`);
        }
      }
    } else if (block.type === 'actions' && 'elements' in block) {
      const buttons = block.elements
        .map((element) => ('text' in element ? `[ ${element.text.text} ]` : ''))
        .filter(Boolean)
        .join('  ');
      process.stdout.write(`${bar} ${buttons}\n`);
    } else if (block.type === 'divider') {
      process.stdout.write(`${bar} ${'─'.repeat(width - 2)}\n`);
    }
  }

  process.stdout.write(`\x1b[2m└─ accent ${accent} · fallback: ${message.text}\x1b[0m\n`);
}

/** Turns Slack markdown into something legible in a terminal. */
const slackish = (text: string): string =>
  text
    .replace(/\*(.+?)\*/g, '\x1b[1m$1\x1b[0m')
    .replace(/_(.+?)_/g, '\x1b[3m$1\x1b[0m')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// --------------------------------------------------------------------- cases

const dailyMatches = [
  match('ATP Example Open', 'Player A', 'Player B', new Date('2026-09-15T10:00:00Z'), '2026-09-15'),
  match('ATP Example Open', 'Player C', 'Player D', new Date('2026-09-15T13:30:00Z'), '2026-09-15'),
  match('ATP Other Open', 'Player E', 'Player F', null, '2026-09-15'),
];

render(
  'DAILY — matches published',
  buildDailySummary({ date: '2026-09-15', matches: dailyMatches, tournaments: [] }, OPTIONS),
);

render(
  'DAILY — tournament on, order of play not out',
  buildDailySummary(
    {
      date: '2026-09-23',
      matches: [],
      tournaments: [
        tournament(
          'ATP Hangzhou',
          '2026-09-23',
          '2026-09-29',
          'Hangzhou',
          '/tournaments/hangzhou-open',
        ),
      ],
    },
    OPTIONS,
  ),
);

render(
  'WEEKLY — mixed',
  buildWeeklySummary(
    {
      from: '2026-09-14',
      to: '2026-09-20',
      matches: [
        ...dailyMatches.slice(0, 2),
        match(
          'ATP Example Open',
          'Player G',
          'Player H',
          new Date('2026-09-17T12:00:00Z'),
          '2026-09-17',
        ),
        match('ATP Example Open', 'Player I', 'Player J', null, '2026-09-17'),
      ],
      tournaments: [
        tournament(
          'ATP Chengdu',
          '2026-09-19',
          '2026-09-25',
          'Chengdu',
          '/tournaments/chengdu-open',
        ),
      ],
    },
    OPTIONS,
  ),
);

render(
  'WEEKLY — nothing on',
  buildWeeklySummary(
    { from: '2026-09-14', to: '2026-09-20', matches: [], tournaments: [] },
    OPTIONS,
  ),
);

render(
  'MONTHLY — busy month',
  buildMonthlySummary(
    {
      from: '2026-09-01',
      to: '2026-09-30',
      tournaments: [
        tournament(
          'ATP Hangzhou',
          '2026-09-23',
          '2026-09-29',
          'Hangzhou',
          '/tournaments/hangzhou-open',
        ),
        tournament(
          'ATP Chengdu',
          '2026-09-23',
          '2026-09-29',
          'Chengdu',
          '/tournaments/chengdu-open',
        ),
        tournament('ATP Tokyo', '2026-09-30', '2026-10-06', 'Tokyo'),
        tournament('ATP Beijing', '2026-09-30', '2026-10-06', 'Beijing'),
      ],
      matches: dailyMatches,
    },
    OPTIONS,
  ),
);

const liveMatch = match(
  'ATP Cincinnati',
  'Sinner',
  'Alcaraz',
  new Date('2026-08-15T18:04:00Z'),
  '2026-08-15',
);
const alertView = {
  match: liveMatch,
  subscriberIds: ['U123ABC', 'U456DEF'],
  observedAt: new Date('2026-08-15T18:04:00Z'),
};

render('LIVE alert', buildAlert('LIVE', alertView, OPTIONS));
render(
  'DELAYED alert — with a republished time',
  buildAlert(
    'DELAYED',
    {
      ...alertView,
      reason: 'Rain',
      previousStartsAtUtc: new Date('2026-08-15T13:00:00Z'),
      newStartsAtUtc: new Date('2026-08-15T14:00:00Z'),
    },
    OPTIONS,
  ),
);
render(
  'DELAYED alert — no new time published',
  buildAlert('DELAYED', { ...alertView, reason: 'Rain' }, OPTIONS),
);
render('CANCELLED alert', buildAlert('CANCELLED', { ...alertView, reason: 'Walkover' }, OPTIONS));

render('EPHEMERAL — opted in', buildSubscriptionConfirmation(true, true));
render('EPHEMERAL — already opted in', buildSubscriptionConfirmation(true, false));
render('EPHEMERAL — opted out', buildSubscriptionConfirmation(false, true));
render(
  'EPHEMERAL — error',
  buildErrorResponse("Couldn't update your alert preference.", 'ECONNRESET'),
);
// A drill should look almost exactly like the real thing; this is the check.
render('SIMULATED LIVE alert', markAsSimulation(buildAlert('LIVE', alertView, OPTIONS)));

if (WRITE_JSON) {
  process.stdout.write(`\n\x1b[2mPayloads written to ${OUT_DIR}\x1b[0m\n`);
}

process.stdout.write('\n');
