/**
 * The scheduling system.
 *
 * Pure calendar reasoning only. There is no runner and no timer here any more: what
 * *triggers* a run is a GitHub Actions cron, and what decides whether a report is
 * actually due is `dueOccurrences` plus the report key's record in the state API
 * (docs/ARCHITECTURE.md §15).
 */

export {
  CRON_EXPRESSIONS,
  SUMMARY_HOUR,
  SUMMARY_KINDS,
  dueOccurrences,
  isDue,
  isWithinGrace,
  occurrenceFor,
  type Occurrence,
  type OccurrenceOptions,
} from './occurrences.ts';

export { reportKey, reportLabel } from './report-keys.ts';
