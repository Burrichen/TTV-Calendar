/**
 * Fixture sanitisation.
 *
 * Fixtures are committed to the repository, so this is the last line of defence
 * against persisting anything we should not. It is deny-list driven and applied
 * recursively to every object in a payload.
 *
 * Nothing here is about hiding how the API works — the whole point of the fixtures is
 * to document that. It is about not committing credentials, session state, signed
 * media URLs, or personal detail the bot has no use for.
 */

/** Keys dropped wherever they appear, at any depth. */
const DROP_KEYS = new Set(
  [
    // credentials / session / entitlement
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
    // signed or entitlement-bearing media URLs — not needed by the bot
    'onDemandUrl',
    'playbackUrl',
    'streamUrl',
    'hlsUrl',
    'drm',
    // personal detail the bot never uses — players and named officials alike
    'BirthDate',
    'BirthCity',
    'BirthCountry',
    'Age',
    'birthDate',
    'birthCity',
    'email',
    'phone',
    'Umpire',
    'UmpireFirstName',
    'UmpireLastName',
    'OfficialId',
    'OfficialItfId',
    // player earnings, carried inside `winners` blocks
    'winners',
    'careerPrize',
    'ytdPrize',
    // third-party identifiers and commercial data we have no use for
    'srSeasonIds',
    'srMatchId',
    'prize',
    'commitment',
    'tdiId',
    'ScorerCode',
  ].map((key) => key.toLowerCase()),
);

export function sanitise<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(key.toLowerCase())) continue;
    out[key] = walk(child);
  }
  return out;
}

/**
 * Keeps a fixture small while staying representative.
 *
 * Rather than "first N", this takes up to `perStratum` items from each distinct
 * stratum (e.g. each Status × time-shape combination), so rare-but-important records
 * — a cancellation, a walkover, a match with no published time — always survive into
 * the fixture, and a 967-match Grand Slam does not.
 */
export function stratifiedSample<T>(
  items: readonly T[],
  stratumOf: (item: T) => string,
  perStratum = 3,
): T[] {
  const taken = new Map<string, number>();
  const out: T[] = [];

  for (const item of items) {
    const stratum = stratumOf(item);
    const count = taken.get(stratum) ?? 0;
    if (count >= perStratum) continue;
    taken.set(stratum, count + 1);
    out.push(item);
  }

  return out;
}
