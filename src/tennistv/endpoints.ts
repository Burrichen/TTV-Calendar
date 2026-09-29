/**
 * Tennis TV's addresses.
 *
 * These live inside the provider module, not in `config/`, so that ARCHITECTURE.md
 * §5.4 stays literally true: if Tennis TV moves, every file that needs editing is in
 * `src/tennistv/`. Configuration may still override any of them per environment —
 * nothing here is hard-coded into behaviour, only defaulted.
 *
 * Evidence for each value: docs/TENNISTV_DATA_SOURCE.md §3.
 */

/** The JSON API the site's own front end calls. */
export const DEFAULT_API_BASE_URL = 'https://api.tennistv.com';

/** The public site, used only to build source URLs for Slack messages. */
export const DEFAULT_SITE_BASE_URL = 'https://www.tennistv.com';

/**
 * Sent as the `account-id` request header. A tenant selector that the public front end
 * sends on every request — not a credential, and not a secret.
 */
export const DEFAULT_ACCOUNT_ID = '35';
