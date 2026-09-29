import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Enforces ARCHITECTURE.md §15: Tennis TV knowledge lives inside `src/tennistv/` and
 * nowhere else.
 *
 * This is the rule that makes a Tennis TV redesign a one-module repair instead of a
 * codebase-wide hunt, and conventions alone do not survive contact with a deadline.
 * The check is deliberately crude — a substring scan — because it needs to be obvious
 * what would make it fail.
 */

const SRC = join(process.cwd(), 'src');

/** The one module allowed to know any of this. */
const PROVIDER_DIR = join(SRC, 'tennistv');

/**
 * Provider field names, hosts and headers that must not leak upwards.
 *
 * Note what is absent: `MatchId`. That is the name of our own composite-identity type
 * in `domain/types.ts`, and banning the string would ban the domain concept.
 */
const FORBIDDEN = [
  'api.tennistv.com',
  'tennis/v1',
  'account-id',
  'PulseStatus',
  'MatchDate',
  'NotBeforeISOTime',
  'NotBeforeText',
  'TeamsInMatch',
  'PlayerTeam1',
  'PlayerTeam2',
  'availableOopDays',
  'notShown',
  'broadcastText',
  'customRoute',
  'matchesSize',
];

/**
 * Strips comments, leaving string literals intact.
 *
 * A comment explaining *why* a domain rule exists — "431 records carried Status
 * 'Finished' with PulseStatus 'U'" — is documentation worth keeping, so comments are
 * not scanned. String literals emphatically ARE.
 *
 * This is a character scanner rather than a regex because a naive `//.*$` strips the
 * tail of every URL, which would blind the check to `https://api.tennistv.com/...` —
 * the one string it most needs to catch.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        // Keep escapes intact so a literal quote does not end the string early.
        if (source[index] === '\\') {
          out += source[index] ?? '';
          index += 1;
        }
        out += source[index] ?? '';
        index += 1;
      }
      out += quote;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Matches a term only as a whole identifier.
 *
 * Without this, `notShown` would flag our own `notShownReason` domain field, and the
 * test would be pressuring us to rename domain concepts to satisfy a grep.
 */
function mentions(source: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(source);
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('Tennis TV provider boundary', () => {
  it('keeps provider field names and endpoints inside src/tennistv/', async () => {
    const files = (await sourceFiles(SRC)).filter((file) => !file.startsWith(PROVIDER_DIR));
    const leaks: string[] = [];

    for (const file of files) {
      const contents = stripComments(await readFile(file, 'utf8'));
      for (const term of FORBIDDEN) {
        if (mentions(contents, term)) {
          leaks.push(`${relative(process.cwd(), file)}: "${term}"`);
        }
      }
    }

    expect(
      leaks,
      'Tennis TV knowledge has leaked outside src/tennistv/. Move it behind the ' +
        'provider interface — see docs/ARCHITECTURE.md §15.',
    ).toEqual([]);
  });

  it('lets no module outside src/tennistv/ import a provider implementation', async () => {
    const files = (await sourceFiles(SRC)).filter((file) => !file.startsWith(PROVIDER_DIR));
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const forbidden of [
        'http-provider',
        'fixture-provider',
        'http-client',
        'mapper',
        'schemas',
      ]) {
        if (contents.includes(`tennistv/${forbidden}`)) {
          offenders.push(`${relative(process.cwd(), file)} imports ${forbidden}`);
        }
      }
    }

    expect(
      offenders,
      'Depend on the TennisTvProvider interface (or the factory in tennistv/index.ts), ' +
        'never on a concrete implementation.',
    ).toEqual([]);
  });

  it('keeps the domain free of every outward dependency', async () => {
    // domain/ is the innermost layer: no database, no Slack, no provider, no HTTP.
    const files = await sourceFiles(join(SRC, 'domain'));
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const forbidden of ['../db/', '../tennistv/', '../slack/', '@slack/', 'kysely', 'pg']) {
        if (contents.includes(`from '${forbidden}`)) {
          offenders.push(`${relative(process.cwd(), file)} imports ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
