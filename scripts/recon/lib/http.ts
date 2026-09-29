/**
 * Polite HTTP client for reconnaissance only.
 *
 * Rules it enforces (PROJECT_SPEC.md §2):
 *  - honest, identifiable User-Agent
 *  - serialised requests with a minimum gap, so we never burst
 *  - no cookies are sent, stored, or persisted
 *  - response headers are captured for cache/last-modified analysis, minus any
 *    `set-cookie` / auth-ish header, which is dropped before it can reach disk
 */

export interface RecordedResponse {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  durationMs: number;
  headers: Record<string, string>;
  bodyBytes: number;
  json: unknown;
  text?: string;
  error?: string;
}

const USER_AGENT =
  'TTVCalendarBot-Recon/0.1 (internal QA scheduling tool; authorised by Tennis TV)';

/** Headers we refuse to persist even if the server sends them. */
const HEADER_DENY_LIST = new Set([
  'set-cookie',
  'authorization',
  'www-authenticate',
  'proxy-authenticate',
]);

const MIN_GAP_MS = 400;
let lastRequestAt = 0;

async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

function captureHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (!HEADER_DENY_LIST.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Keep the raw body text (used for HTML/JS discovery, never for JSON fixtures). */
  keepText?: boolean;
}

export async function recordedFetch(
  url: string,
  options: FetchOptions = {},
): Promise<RecordedResponse> {
  await pace();
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      // `credentials: 'omit'` is the default for fetch() in Node; stated for intent.
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...options.headers },
      signal: AbortSignal.timeout(20_000),
    });

    const text = await response.text();
    const durationMs = Math.round(performance.now() - started);

    let json: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    const result: RecordedResponse = {
      url,
      method: 'GET',
      status: response.status,
      ok: response.ok,
      durationMs,
      headers: captureHeaders(response.headers),
      bodyBytes: Buffer.byteLength(text),
      json,
    };
    if (options.keepText) result.text = text;
    return result;
  } catch (error) {
    return {
      url,
      method: 'GET',
      status: 0,
      ok: false,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      bodyBytes: 0,
      json: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
