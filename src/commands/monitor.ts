/**
 * `npm run bot:monitor` — one live-state check.
 *
 * Invoked every 30 minutes by `.github/workflows/tennis-monitor.yml`, and manually via
 * that workflow's `workflow_dispatch`. Starts, checks, posts anything that is genuinely
 * news, and exits.
 */

import { runMonitor } from '../jobs/monitor.ts';
import { execute } from './runtime.ts';

await execute(
  'monitor',
  (runtime) =>
    runMonitor({
      provider: runtime.provider,
      publisher: runtime.publisher,
      state: runtime.state,
      config: runtime.config,
      logger: runtime.logger,
      now: new Date(),
    }),
  (result) => ({
    tournamentsToday: result.tournamentsToday,
    matchesChecked: result.checked,
    transitions: result.transitions,
    alertsSent: result.alerted,
    alertsSuppressed: result.suppressed,
    alertsFailed: result.failed,
    subscribers: result.subscribers,
  }),
);
