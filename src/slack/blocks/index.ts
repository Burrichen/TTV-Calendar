/** Every Block Kit builder, in one import. All pure functions over view models. */

export {
  buildDailySummary,
  buildMonthlySummary,
  buildWeeklySummary,
  type DailySummaryView,
  type MonthlySummaryView,
  type SummaryOptions,
  type WeeklySummaryView,
} from './summaries.ts';

export {
  NoRecipientsError,
  buildAlert,
  buildCancelledAlert,
  buildDelayedAlert,
  buildLiveAlert,
  type AlertOptions,
  type AlertView,
} from './alerts.ts';

export { buildErrorResponse, buildSubscriptionConfirmation } from './diagnostics.ts';

export {
  SUBSCRIPTION_ACTION_IDS,
  SUBSCRIPTION_BLOCK_ID,
  subscriptionActions,
} from './subscription.ts';

export {
  BANNED_MENTIONS,
  RENDER_LIMITS,
  SLACK_LIMITS,
  type BuiltMessage,
  blockText,
  containsBannedMention,
} from './common.ts';

export {
  NAVIGATION_ACTION_IDS,
  NAVIGATION_BLOCK_ID,
  NAVIGATION_ROWS,
  navigationActions,
  type NavigationButton,
} from './navigation.ts';

export { ACCENTS, type Accent } from './theme.ts';

export { TEST_MARKER, markAsSimulation } from './simulation.ts';
