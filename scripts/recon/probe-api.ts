/**
 * Step 2 of reconnaissance: probe the JSON API the front end uses.
 *
 * This file is deliberately the only place in the repo outside src/tennistv/ that
 * knows Tennis TV's endpoint shapes, and it exists to *document* them.
 */

import { recordedFetch, type RecordedResponse } from './lib/http.ts';

export interface ApiConfig {
  base: string;
  headerName: string;
  headerValue: string;
}

export interface ProbeResult {
  label: string;
  path: string;
  status: number;
  bodyBytes: number;
  durationMs: number;
  topLevelShape: string;
  itemCount: number | null;
  cacheHeaders: Record<string, string>;
  note?: string;
}

const CACHE_HEADER_KEYS = [
  'date',
  'last-modified',
  'etag',
  'cache-control',
  'age',
  'expires',
  'x-cache',
];

export async function apiGet(config: ApiConfig, path: string): Promise<RecordedResponse> {
  return recordedFetch(`${config.base}${path}`, {
    headers: { [config.headerName]: config.headerValue, accept: 'application/json' },
  });
}

export function describe(label: string, path: string, response: RecordedResponse): ProbeResult {
  const body = response.json;
  const items = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { matches?: unknown[] }).matches)
      ? (body as { matches: unknown[] }).matches
      : null;

  const cacheHeaders: Record<string, string> = {};
  for (const key of CACHE_HEADER_KEYS) {
    const value = response.headers[key];
    if (value !== undefined) cacheHeaders[key] = value;
  }

  return {
    label,
    path,
    status: response.status,
    bodyBytes: response.bodyBytes,
    durationMs: response.durationMs,
    topLevelShape: Array.isArray(body)
      ? 'array'
      : body && typeof body === 'object'
        ? `object{${Object.keys(body).join(',')}}`
        : typeof body,
    itemCount: items ? items.length : null,
    cacheHeaders,
  };
}

/**
 * Probes the parameter matrix so the documented request shape is evidence-based
 * rather than copied from the bundle and hoped for.
 */
export async function probeParameterMatrix(
  config: ApiConfig,
  sampleTournament: { id: number; year: number },
  window: { from: string; to: string },
): Promise<ProbeResult[]> {
  const { id, year } = sampleTournament;
  const probes: { label: string; path: string; note?: string }[] = [
    { label: 'tournaments (no params)', path: '/tournaments' },
    { label: 'tournaments (year= only)', path: `/tournaments?year=${year}` },
    {
      label: 'tournaments (from/to/size/page)',
      path: `/tournaments?from=${window.from}&to=${window.to}&size=200&page=0`,
    },
    {
      label: 'tournaments (page 1)',
      path: `/tournaments?from=${window.from}&to=${window.to}&size=5&page=1`,
    },
    { label: 'tournament detail', path: `/tournaments/${id}/${year}` },
    { label: 'matches (no params)', path: '/matches' },
    { label: 'matches (tournamentId+year)', path: `/matches?tournamentId=${id}&year=${year}` },
    { label: 'matches (status=L)', path: '/matches?status=L' },
    { label: 'matches (status=U)', path: '/matches?status=U' },
    { label: 'matches (date only)', path: `/matches?date=${window.from}` },
    { label: 'oop (no params)', path: '/oop' },
    { label: 'oop (date)', path: `/oop?date=${window.from}` },
    { label: 'oop (tournamentId+year)', path: `/oop?tournamentId=${id}&year=${year}` },
  ];

  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const response = await apiGet(config, probe.path);
    const described = describe(probe.label, probe.path, response);
    if (probe.note) described.note = probe.note;
    if (response.error) described.note = `request failed: ${response.error}`;
    results.push(described);
  }
  return results;
}
