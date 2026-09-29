/**
 * `npm run bot:morning` — the daily, weekly and monthly reports.
 *
 * Invoked by `.github/workflows/tennis-morning.yml`, which fires at two UTC times so
 * that one of them is always 08:00 in `Europe/London`, whichever side of a daylight
 * saving change today falls. This command decides which of the two it is by asking
 * Luxon, not by arithmetic: the run that is not yet 08:00 locally finds nothing due and
 * exits cleanly, and the one that is an hour late finds the key already settled.
 */

import { runMorning } from '../jobs/morning.ts';
import { execute } from './runtime.ts';

await execute(
  'morning',
  (runtime) =>
    runMorning({
      provider: runtime.provider,
      publisher: runtime.publisher,
      state: runtime.state,
      config: runtime.config,
      logger: runtime.logger,
      now: new Date(),
    }),
  (result) => ({
    due: result.due,
    reportsPosted: result.posted,
    reportsSkipped: result.skipped,
    reportsFailed: result.failed,
  }),
);
