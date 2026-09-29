/**
 * Step 1 of reconnaissance: work out how tennistv.com itself obtains schedule data,
 * without a browser and without guessing.
 *
 * 1. fetch the public /tournaments page
 * 2. detect whether the schedule is server-rendered or client-rendered
 * 3. find the front-end's JavaScript entry bundle
 * 4. read the API base URL, required header, and endpoint paths out of that bundle
 *
 * Everything it reports is extracted from the response bodies, never assumed.
 */

import { recordedFetch } from './lib/http.ts';

export interface FrontendDiscovery {
  page: {
    url: string;
    status: number;
    bytes: number;
    lastModified?: string;
    cacheControl?: string;
  };
  rendering: 'server-rendered' | 'client-rendered-widget' | 'unknown';
  widgetsOnPage: string[];
  bundleUrl?: string;
  apiBaseFromBundle?: string;
  apiHeaderFromBundle?: { name: string; value: string };
  endpointPathsFromBundle: string[];
  statusConstantsFromBundle?: Record<string, unknown>;
  notes: string[];
}

const RE_WIDGET = /data-widget="([^"]+)"/g;
const RE_BUNDLE = /import\("(\/resources\/[^"]+\/scripts\/bundle-es\.min\.js)"\)/;
const RE_ENV_BLOCK = /accountId:\s*(\d+)[\s\S]{0,400}?tennisApi:"([^"]+)"/;
const RE_API_BASE = /baseUrl:`\$\{environment\.tennisApi\}(\/[a-z0-9/]+)`/i;
const RE_API_HEADER = /prepareHeaders:[^}]*?\.set\("([^"]+)",environment\.(\w+)\)/;
const RE_MATCH_STATES = /MATCH_STATES=(\{[\s\S]*?\}),[A-Z_]+=/;

export async function discoverFrontend(siteBaseUrl: string): Promise<FrontendDiscovery> {
  const notes: string[] = [];
  const pageUrl = `${siteBaseUrl}/tournaments`;
  const page = await recordedFetch(pageUrl, { keepText: true });
  const html = page.text ?? '';

  const widgets = [...html.matchAll(RE_WIDGET)].flatMap((m) => m[1] ?? []);
  const uniqueWidgets = [...new Set(widgets)].sort();

  const calendarWidget = uniqueWidgets.find((w) => w.includes('calendar'));
  // A server-rendered schedule would contain tournament names in the HTML itself.
  const looksServerRendered = /class="[^"]*tournament-calendar__(name|title)/.test(html);

  const rendering: FrontendDiscovery['rendering'] = looksServerRendered
    ? 'server-rendered'
    : calendarWidget
      ? 'client-rendered-widget'
      : 'unknown';

  if (rendering === 'client-rendered-widget') {
    notes.push(
      `The schedule is rendered client-side by the "${calendarWidget}" widget; the ` +
        'page HTML contains an empty container, so DOM scraping this URL would yield nothing.',
    );
  }

  const result: FrontendDiscovery = {
    page: {
      url: pageUrl,
      status: page.status,
      bytes: page.bodyBytes,
      ...(page.headers['last-modified'] ? { lastModified: page.headers['last-modified'] } : {}),
      ...(page.headers['cache-control'] ? { cacheControl: page.headers['cache-control'] } : {}),
    },
    rendering,
    widgetsOnPage: uniqueWidgets,
    endpointPathsFromBundle: [],
    notes,
  };

  const bundleMatch = RE_BUNDLE.exec(html);
  if (!bundleMatch) {
    notes.push('Could not locate the front-end entry bundle in the page HTML.');
    return result;
  }

  const bundlePath = bundleMatch[1];
  if (bundlePath === undefined) {
    notes.push('Matched the bundle tag but could not read its path.');
    return result;
  }

  result.bundleUrl = `${siteBaseUrl}${bundlePath}`;
  const bundle = await recordedFetch(result.bundleUrl, { keepText: true });
  const js = bundle.text ?? '';

  const env = RE_ENV_BLOCK.exec(js);
  const apiPrefix = RE_API_BASE.exec(js);
  const header = RE_API_HEADER.exec(js);

  const accountId = env?.[1];
  const apiHost = env?.[2];
  const apiPath = apiPrefix?.[1];

  if (accountId !== undefined && apiHost !== undefined && apiPath !== undefined) {
    result.apiBaseFromBundle = `${apiHost.replace(/^\/\//, 'https://')}${apiPath}`;
    const headerName = header?.[1];
    if (headerName !== undefined && header?.[2] === 'accountId') {
      result.apiHeaderFromBundle = { name: headerName, value: accountId };
    }
    notes.push(
      'The API base URL and required request header were read directly out of the ' +
        "site's own JavaScript bundle — they are what the public front end uses.",
    );
  }

  // Endpoint paths appear as RTK Query template literals, e.g. `/oop${prepareParams(e)}`.
  const paths = new Set<string>();
  for (const m of js.matchAll(/query:[^`]{0,80}`(\/[^`]+)`/g)) {
    const raw = m[1];
    if (raw === undefined) continue;
    paths.add(
      raw.replace(/\$\{prepareParams\([^)]*\)\}/g, '{?params}').replace(/\$\{[^}]+\}/g, '{id}'),
    );
  }
  result.endpointPathsFromBundle = [...paths].sort();

  const states = RE_MATCH_STATES.exec(js)?.[1];
  if (states !== undefined) {
    result.statusConstantsFromBundle = parseLooseObject(states);
    notes.push(
      'MATCH_STATES is the vocabulary the front end believes in. Observed API data ' +
        'must still be tallied separately — the two are not guaranteed to agree.',
    );
  }

  return result;
}

/** Parses the minified, unquoted-key object literal used for MATCH_STATES. */
function parseLooseObject(source: string): Record<string, unknown> {
  const quoted = source.replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(quoted) as Record<string, unknown>;
  } catch {
    return { _unparsed: source.slice(0, 400) };
  }
}
