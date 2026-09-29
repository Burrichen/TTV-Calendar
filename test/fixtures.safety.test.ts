import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Fixtures are committed, so this test is the guard that keeps a future re-capture
 * from quietly adding credentials, session state, signed media URLs or personal
 * detail to the repository (PROJECT_SPEC.md §2).
 *
 * It mirrors the deny-list in scripts/recon/lib/sanitise.ts. If the two drift, this
 * test fails — which is the point.
 */

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'tennistv');

const DENIED_KEYS = new Set(
  [
    'token',
    'accessToken',
    'refreshToken',
    'idToken',
    'jwt',
    'sessionId',
    'session',
    'cookie',
    'cookies',
    'authorization',
    'auth',
    'apiKey',
    'signature',
    'sig',
    'onDemandUrl',
    'playbackUrl',
    'streamUrl',
    'hlsUrl',
    'drm',
    'BirthDate',
    'BirthCity',
    'BirthCountry',
    'Age',
    'email',
    'phone',
    'Umpire',
    'UmpireFirstName',
    'UmpireLastName',
    'OfficialId',
    'OfficialItfId',
    'winners',
    'careerPrize',
    'ytdPrize',
    'srSeasonIds',
    'srMatchId',
    'prize',
    'commitment',
    'tdiId',
    'ScorerCode',
  ].map((key) => key.toLowerCase()),
);

/** Anything that looks like a bearer token, JWT or signed URL, wherever it hides. */
const SECRET_SHAPED = [
  /\beyJ[A-Za-z0-9_-]{10,}\./, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  /[?&](token|sig|signature|Policy|Key-Pair-Id)=/i,
];

function findDeniedKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) findDeniedKeys(item, path, hits);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DENIED_KEYS.has(key.toLowerCase())) hits.push(`${path}.${key}`);
    findDeniedKeys(child, `${path}.${key}`, hits);
  }
}

describe('committed Tennis TV fixtures', () => {
  it('contains fixtures to check', async () => {
    const files = await readdir(FIXTURE_DIR);
    expect(files.filter((file) => file.endsWith('.json')).length).toBeGreaterThan(0);
  });

  it('carries no denied keys and nothing secret-shaped', async () => {
    const files = (await readdir(FIXTURE_DIR)).filter((file) => file.endsWith('.json'));

    for (const file of files) {
      const raw = await readFile(join(FIXTURE_DIR, file), 'utf8');

      for (const pattern of SECRET_SHAPED) {
        expect(pattern.test(raw), `${file} matched ${pattern}`).toBe(false);
      }

      const hits: string[] = [];
      findDeniedKeys(JSON.parse(raw), file, hits);
      expect(hits, `denied keys in ${file}`).toEqual([]);
    }
  });
});
