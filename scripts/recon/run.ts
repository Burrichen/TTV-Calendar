/**
 * Reconnaissance entry point.  `npm run recon`
 *
 * Writes:
 *   .recon-out/recon-report.json      full machine-readable findings
 *   .recon-out/recon-report.md        human-readable summary
 *   test/fixtures/tennistv/*.json     sanitised fixtures for the test suite
 *
 * Read-only against Tennis TV. Sends no cookies, no credentials, and bypasses
 * nothing. Access is covered by the approval recorded in PROJECT_SPEC.md §2.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { recordedFetch } from './lib/http.ts';
import { discoverFrontend } from './discover-frontend.ts';
import { probeParameterMatrix, type ApiConfig } from './probe-api.ts';
import { capture, isoDate } from './capture.ts';
import { sanitise, stratifiedSample } from './lib/sanitise.ts';
import { renderMarkdown } from './report.ts';

const SITE_BASE = process.env.TENNISTV_BASE_URL ?? 'https://www.tennistv.com';
const OUT_DIR = '.recon-out';
const FIXTURE_DIR = join('test', 'fixtures', 'tennistv');

async function main(): Promise<void> {
  const today = process.env.RECON_TODAY ?? isoDate(new Date());
  console.error(`[recon] site=${SITE_BASE} today=${today}`);

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(FIXTURE_DIR, { recursive: true });

  console.error('[recon] 1/5 checking robots.txt');
  const robots = await recordedFetch(`${SITE_BASE}/robots.txt`, { keepText: true });

  console.error('[recon] 2/5 discovering how the front end loads its data');
  const frontend = await discoverFrontend(SITE_BASE);
  if (!frontend.apiBaseFromBundle || !frontend.apiHeaderFromBundle) {
    throw new Error(
      'Could not extract the API base/header from the front-end bundle. The site has ' +
        'likely changed; inspect .recon-out and update scripts/recon/discover-frontend.ts.',
    );
  }

  const config: ApiConfig = {
    base: frontend.apiBaseFromBundle,
    headerName: frontend.apiHeaderFromBundle.name,
    headerValue: frontend.apiHeaderFromBundle.value,
  };
  console.error(`[recon]     api=${config.base} header=${config.headerName}`);

  console.error('[recon] 3/5 capturing tournaments and match samples');
  const captured = await capture(config, today);

  if (captured.tournamentCount === 0) {
    throw new Error(
      'The tournament listing returned zero rows. That is almost certainly a harness ' +
        'or API-contract problem rather than reality — investigate before trusting any ' +
        'other finding in this run.',
    );
  }

  console.error('[recon] 4/5 probing the parameter matrix');
  const anchor =
    captured.matchSamples.find((sample) => sample.matchCount > 0)?.tournament ??
    captured.notShownTournaments[0];
  const probes = anchor
    ? await probeParameterMatrix(
        config,
        { id: anchor.id, year: anchor.year },
        { from: today, to: today },
      )
    : [];

  const report = {
    meta: {
      capturedAt: captured.capturedAt,
      today,
      siteBaseUrl: SITE_BASE,
      apiBaseUrl: config.base,
      apiHeader: `${config.headerName}: ${config.headerValue}`,
      robotsTxtStatus: robots.status,
      robotsTxtDisallowsApi: (robots.text ?? '').includes('api.tennistv.com'),
    },
    frontend,
    probes,
    capture: { ...captured, rawTournaments: undefined, rawMatchesByTournament: undefined },
  };

  // Raw payloads are kept (gitignored) so later analysis can iterate without
  // re-fetching from Tennis TV.
  await mkdir(join(OUT_DIR, 'raw'), { recursive: true });
  await writeFile(
    join(OUT_DIR, 'raw', 'tournaments.json'),
    `${JSON.stringify(captured.rawTournaments, null, 2)}\n`,
  );
  for (const [key, matches] of Object.entries(captured.rawMatchesByTournament)) {
    await writeFile(
      join(OUT_DIR, 'raw', `matches-${key}.json`),
      `${JSON.stringify({ matches }, null, 2)}\n`,
    );
  }

  await writeFile(join(OUT_DIR, 'recon-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(OUT_DIR, 'recon-report.md'), renderMarkdown(report as never));
  console.error('[recon] 5/5 writing sanitised fixtures');
  await writeFixtures(captured);

  console.error(`[recon] done → ${OUT_DIR}/recon-report.md`);
}

interface RawMatchLike {
  Status?: string;
  PulseStatus?: string;
  Reason?: string;
  MatchDate?: string;
  NotBeforeISOTime?: string;
  NotBeforeText?: string;
  NotBefore?: string;
}

async function writeFixtures(captured: Awaited<ReturnType<typeof capture>>): Promise<void> {
  // Tournaments: keep the whole season list — it is small and it is the fixture the
  // availability rule and the window queries are tested against.
  await writeFile(
    join(FIXTURE_DIR, 'tournaments-season.json'),
    `${JSON.stringify(sanitise(captured.rawTournaments), null, 2)}\n`,
  );

  for (const [key, matches] of Object.entries(captured.rawMatchesByTournament)) {
    if (matches.length === 0) {
      await writeFile(
        join(FIXTURE_DIR, `matches-${key}.json`),
        `${JSON.stringify({ matches: [] }, null, 2)}\n`,
      );
      continue;
    }
    // One fixture must cover every combination of status and time representation the
    // tournament exhibits, without carrying a whole Grand Slam draw into git.
    const sample = stratifiedSample(
      matches as RawMatchLike[],
      (match) => {
        const timeOfDay = (match.MatchDate ?? '').slice(11, 19);
        const timeShape = !match.MatchDate
          ? 'no-MatchDate'
          : timeOfDay === '' || timeOfDay === '00:00:00'
            ? 'no-time-of-day'
            : 'has-time';
        return [
          match.Status ?? '(none)',
          match.PulseStatus ?? '(none)',
          match.Reason ?? '(none)',
          timeShape,
          match.NotBeforeText ?? match.NotBefore ?? '(no-NotBeforeText)',
        ].join('|');
      },
      3,
    );
    await writeFile(
      join(FIXTURE_DIR, `matches-${key}.json`),
      `${JSON.stringify(sanitise({ matches: sample }), null, 2)}\n`,
    );
  }
}

await main();
