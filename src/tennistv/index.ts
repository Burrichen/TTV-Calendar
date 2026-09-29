/**
 * Provider selection.
 *
 * The rest of the application asks for "a provider" and gets one; which
 * implementation it is depends on `TENNISTV_PROVIDER` (PROJECT_SPEC.md §12).
 */

import { join } from 'node:path';

import type { Logger } from '../logging/types.ts';
import { FixtureTennisTvProvider } from './fixture-provider.ts';
import { HttpTennisTvProvider } from './http-provider.ts';
import type { TennisTvProvider } from './provider.ts';

export type {
  DateRange,
  MatchSnapshot,
  ProviderMatch,
  ProviderTournament,
  TennisTvProvider,
  TournamentSnapshot,
} from './provider.ts';
export {
  TennisTvError,
  TennisTvHttpError,
  TennisTvSchemaError,
  isRetryable,
  isTennisTvError,
} from './errors.ts';

const DEFAULT_FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures', 'tennistv');

export interface ProviderOptions {
  /** `live` talks to Tennis TV; `fixture` replays recorded responses from disk. */
  readonly mode: 'live' | 'fixture';
  readonly apiBaseUrl: string;
  readonly siteBaseUrl: string;
  readonly accountId: string;
  readonly logger: Logger;
  /** Overridable so tests can point at their own recordings. */
  readonly fixtureDir?: string;
}

/**
 * Builds the provider the rest of the application talks to.
 *
 * Takes plain options rather than the application `Config` so this module stays
 * ignorant of the configuration schema — the dependency runs one way, and an
 * import-graph test enforces it (ARCHITECTURE.md §15).
 */
export function createTennisTvProvider(options: ProviderOptions): TennisTvProvider {
  switch (options.mode) {
    case 'live':
      return new HttpTennisTvProvider({
        apiBaseUrl: options.apiBaseUrl,
        siteBaseUrl: options.siteBaseUrl,
        accountId: options.accountId,
        logger: options.logger,
      });

    case 'fixture':
      return new FixtureTennisTvProvider({
        fixtureDir: options.fixtureDir ?? DEFAULT_FIXTURE_DIR,
        siteBaseUrl: options.siteBaseUrl,
        logger: options.logger,
      });
  }
}
