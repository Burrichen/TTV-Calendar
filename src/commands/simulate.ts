/**
 * `npm run bot:simulate -- <kind>` — a manual drill.
 *
 * Triggered from the GitHub Actions UI by the "Tennis simulation" workflow, which
 * offers the kinds as a dropdown so nobody has to edit code or remember a flag.
 *
 * Every message it sends is banner-marked `🧪 TEST`, keyed so it can never collide with
 * a real one, and written without touching stored match state.
 */

import { isSimulationKind, runSimulation, SIMULATION_KINDS } from '../jobs/simulation.ts';
import { execute } from './runtime.ts';

// `--` separates npm's arguments from ours, so take the last non-flag word.
const requested = (process.argv[2] ?? process.env.SIMULATION_KIND ?? '').trim().toLowerCase();

if (!isSimulationKind(requested)) {
  process.stderr.write(
    `Unknown simulation "${requested}".\n` +
      `Expected one of: ${SIMULATION_KINDS.join(', ')}\n\n` +
      'For example:  npm run bot:simulate -- live\n',
  );
  process.exitCode = 1;
} else {
  await execute(
    `simulate:${requested}`,
    (runtime) =>
      runSimulation(requested, {
        provider: runtime.provider,
        publisher: runtime.publisher,
        state: runtime.state,
        config: runtime.config,
        logger: runtime.logger,
        now: new Date(),
      }),
    (result) => ({ kind: result.kind, posted: result.posted, detail: result.detail }),
  );
}
