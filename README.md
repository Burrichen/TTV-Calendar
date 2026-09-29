# TTV Calendar Bot

A Slack bot that tells the QA/testing team when Tennis TV has live tennis available
for testing: scheduled daily/weekly/monthly summaries, plus opt-in live/delayed/
cancelled alerts posted to a single configured channel.

Tennis TV data access for this project is used with Tennis TV's explicit approval.

## Documentation

- [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md) — the durable source of truth for requirements.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module boundaries, data flow, idempotency, testing, deployment.
- [`docs/TENNISTV_DATA_SOURCE.md`](docs/TENNISTV_DATA_SOURCE.md) — how Tennis TV exposes its data, what was verified, and what is still unknown.
- [`docs/SLACK_SETUP.md`](docs/SLACK_SETUP.md) — creating the Slack app, and why it asks for the scopes it does.
- [`docs/SETUP_FROM_SCRATCH.md`](docs/SETUP_FROM_SCRATCH.md) — **start here to deploy**: Cloudflare, Slack and GitHub, step by step, assuming no prior experience.
- [`docs/FREE_TIER_BUDGET.md`](docs/FREE_TIER_BUDGET.md) — what it costs to run, measured, and how to check your own usage.
- [`docs/CLOUDFLARE_COMPATIBILITY.md`](docs/CLOUDFLARE_COMPATIBILITY.md) — why Tennis TV needs no browser (historical, still accurate).

## How it runs

Nothing runs continuously, and nothing costs anything.

- **GitHub Actions** is the production runtime. It starts a short-lived Node process
  every 30 minutes to check live match state, and each morning to send the reports.
- **A Cloudflare Worker** handles the Slack Opt In / Opt Out buttons — Slack needs a
  public HTTPS endpoint, and a short-lived process cannot be one — and lends its
  **D1** database to the runner through a small secured API.

There is no server, no VPS, no PostgreSQL, no Socket Mode and no Docker in production.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §15–17.

## Getting started

```sh
nvm use                 # Node 24 LTS
npm install
cp .env.example .env    # then fill in the Slack and state API values
npm run verify          # typecheck + lint + tests — no database, no network
```

No Docker and no database are needed to develop or to run the tests.

To exercise a production command locally without touching Slack or the real Tennis TV:

```sh
TENNISTV_PROVIDER=fixture SLACK_DRY_RUN=true npm run bot:morning:local
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run bot:monitor` | **production** — one live-state check, then exit |
| `npm run bot:morning` | **production** — send any report that is due, then exit |
| `npm run bot:monitor:local` / `bot:morning:local` | the same, reading `.env` |
| `npm run verify` | typecheck, lint and test — run this before pushing |
| `npm run typecheck` | `tsc` over the Node project *and* the Worker project |
| `npm run lint` / `lint:fix` | ESLint, type-aware rules |
| `npm run format` / `format:check` | Prettier |
| `npm run test:fast` / `npm test` | the suite — no database, no network |
| `npm run test:contract` | **real Tennis TV** — opt-in, for a scheduled job |
| `npm run test:watch` | Vitest in watch mode |
| `npm run build` | compile to `dist/` |
| `npm run worker:dev` / `worker:deploy` / `worker:build` | the Cloudflare Worker |
| `npm run worker:tail` | stream the Worker's live logs |
| `npm run d1:migrate:local` / `d1:migrate:remote` | apply D1 migrations |
| `npm run recon` / `recon:semantics` | Tennis TV reconnaissance (see below) |
| `npm run preview:messages` | render every Slack message design to the terminal |

### Test layers

The filename says what a test needs, so nobody has to guess why the fast suite is fast:

| Pattern | Needs | Run by |
| --- | --- | --- |
| `*.test.ts` | nothing — fixtures, fakes and in-memory SQLite | `test:fast`, `test` |
| `upstream-contract.test.ts` | the live Tennis TV API | `test:contract` only |

`test/worker/` drives the Worker's own handlers against a real D1 database, backed by
Node's built-in SQLite running the actual migration. The duplicate-prevention design is
a conditional `ON CONFLICT … RETURNING`, so testing it against anything less than real
SQL would only be testing the imitation. Those tests are typechecked against the
Workers runtime (`tsconfig.worker.json`), because Cloudflare's ambient types and Node's
cannot share one TypeScript program.

**Ordinary CI never touches Tennis TV.** The contract test is skipped unless
`TENNISTV_CONTRACT=live`, so a Tennis TV outage can never turn the build red. Run it on
a schedule instead — a failure there means Tennis TV has changed, which is a real signal
and deserves its own alert rather than a broken pull request.

Tests use injected clocks and injected timers throughout — nothing sleeps.

## Reconnaissance

Tennis TV's schedule comes from a JSON API, not from scraping. The harness in
`scripts/recon/` rediscovers and re-verifies that from scratch:

```sh
npm run recon             # fetch, probe, capture → .recon-out/ + sanitised fixtures
npm run recon:semantics   # analyse field meanings from the captured payloads
```

`npm run recon` regenerates `test/fixtures/tennistv/`. If Tennis TV has changed
anything the provider depends on, `test/tennistv-source.contract.test.ts` fails.

Two layers catch a Tennis TV change:

- **Offline, every CI run** — the fixture-driven provider tests run the real schemas
  and mapper over recorded payloads.
- **Online, opt-in** — `npm run test:contract` talks to the live API and fails with a
  message naming the file to edit. Run it nightly; a failure is a real signal.

## Slack

Create the app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml) and follow
[`docs/SLACK_SETUP.md`](docs/SLACK_SETUP.md). Interactivity points at the Cloudflare
Worker's `/slack/interactions` endpoint, which verifies Slack's request signature. No
Socket Mode, and therefore no `SLACK_APP_TOKEN`.

`npm run preview:messages` renders every message design — daily, weekly and monthly
schedules, live/delayed/cancelled alerts, and the ephemeral replies — without needing a
workspace.

## Scheduling

Daily at 08:00 Europe/London, weekly on Mondays, monthly on the 1st.

GitHub's cron is UTC-only, so the morning workflow fires at both 07:00 and 08:00 UTC and
the application decides which one is 08:00 in London. Exactly one posts, because the
report key can only be claimed once; if one run never happens, the other sends it. No
BST/GMT offset is written down anywhere. See `docs/ARCHITECTURE.md` §7 and §15.1.

## Live monitoring

Every 30 minutes, all day. Live, delayed and cancelled alerts go to the same configured
channel, mentioning only the users currently opted in — and nothing is posted at all
when nobody is. A run where no tournament is on makes a single Tennis TV request and
stops. See `docs/ARCHITECTURE.md` §9.

Nothing is ever inferred: a match that vanishes from the feed is not cancelled, and a
start time that has passed is not a delay.

## Testing without waiting for tennis

Simulations use the production code path — real transition rendering, real subscriber
lookup, real message builders, real posting — because a drill that avoids production
code proves nothing.

From the **Actions** tab, run **"Tennis simulation (manual test)"** and pick what to
simulate:

| Choice | Posts |
| --- | --- |
| `live` / `delayed` / `cancelled` | That alert, for a clearly fictional match, mentioning whoever is actually opted in |
| `daily` / `weekly` / `monthly` | That report, built from real Tennis TV data |

Every simulated message carries **🧪 TEST**, uses a throwaway idempotency key, and
writes no match state — so a drill can never be mistaken for real news and can never
suppress a genuine alert later. With nobody opted in it posts nothing and says so, which
makes it a working check that opting in succeeded.

Locally: `npm run bot:simulate -- live`. See `docs/PROJECT_SPEC.md` §12.

## Status

**v1, feature complete.** Daily, weekly and monthly reports; live, delayed and cancelled
alerts; opt-in/opt-out buttons; simulation mode; and a runtime that costs nothing.

To deploy it for the first time, follow
[`docs/SETUP_FROM_SCRATCH.md`](docs/SETUP_FROM_SCRATCH.md) — it assumes no prior
experience of Cloudflare, D1, GitHub Actions or Slack app configuration.

Running costs and how to check them: [`docs/FREE_TIER_BUDGET.md`](docs/FREE_TIER_BUDGET.md).
