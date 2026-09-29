import { defineConfig } from 'vitest/config';

/**
 * Test layers, by what each one needs to run:
 *
 *   *.test.ts                 everything local — fixtures, fakes, and an in-memory
 *                             SQLite database standing in for D1. No network.
 *   upstream-contract.test.ts talks to the real Tennis TV API. Opt-in only.
 *
 * There is no database to start and nothing to install: `npm test` works on a clean
 * checkout. The one test that needs the internet says so in its name and is skipped
 * unless TENNISTV_CONTRACT=live.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    /**
     * Kept serial. Each file that needs a database now builds its own in-memory SQLite,
     * so parallelism would be safe — but the whole suite runs in about three seconds,
     * and serial output is far easier to read when something fails.
     */
    fileParallelism: false,
  },
});
