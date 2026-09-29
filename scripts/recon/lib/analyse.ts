/** Generic, payload-agnostic analysis helpers. No Tennis TV knowledge lives here. */

export interface FieldFact {
  key: string;
  presentIn: number;
  types: string[];
  nullCount: number;
  emptyStringCount: number;
  examples: unknown[];
}

export function fieldInventory(records: readonly unknown[]): FieldFact[] {
  const facts = new Map<string, FieldFact>();

  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      let fact = facts.get(key);
      if (!fact) {
        fact = { key, presentIn: 0, types: [], nullCount: 0, emptyStringCount: 0, examples: [] };
        facts.set(key, fact);
      }
      fact.presentIn += 1;
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      if (!fact.types.includes(type)) fact.types.push(type);
      if (value === null) fact.nullCount += 1;
      if (value === '') fact.emptyStringCount += 1;
      if (fact.examples.length < 3 && value !== null && value !== '' && !isBig(value)) {
        fact.examples.push(value);
      }
    }
  }

  return [...facts.values()].sort(
    (a, b) => b.presentIn - a.presentIn || a.key.localeCompare(b.key),
  );
}

function isBig(value: unknown): boolean {
  return typeof value === 'object' && JSON.stringify(value).length > 160;
}

/** A stable label for any value, without relying on default stringification. */
function describeValue(value: unknown): string {
  if (value === null) return '(null)';
  if (value === undefined) return '(undefined)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol' || typeof value === 'function') return `(${typeof value})`;
  return JSON.stringify(value);
}

export function tally<T>(items: readonly T[], pick: (item: T) => unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const raw = pick(item);
    if (raw === undefined) continue;
    const key = describeValue(raw);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/** Reports whether a set of values is unique — used to test identifier stability. */
export function uniqueness<T>(
  items: readonly T[],
  pick: (item: T) => string | undefined,
): { total: number; distinct: number; unique: boolean; duplicates: string[] } {
  const seen = new Map<string, number>();
  let total = 0;
  for (const item of items) {
    const key = pick(item);
    if (key === undefined) continue;
    total += 1;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  return {
    total,
    distinct: seen.size,
    unique: duplicates.length === 0,
    duplicates: duplicates.slice(0, 10),
  };
}
