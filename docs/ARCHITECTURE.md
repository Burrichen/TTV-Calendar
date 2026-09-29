# TTV Calendar Bot — Architecture

Companion to [`PROJECT_SPEC.md`](PROJECT_SPEC.md), which owns *what* the bot does.
This document owns *how*.

**Last updated:** 2026-09-14

---

## 1. Shape of the system

> **Note.** This section describes the target architecture. The module boundaries,
> domain rules, provider design and idempotency strategy below are unchanged and still
> authoritative; the *runtime* they execute in has moved. See §15 for the current
> topology, §16 for the state API, and §17 for how we got here.

Two runtimes, one small database, and nothing that runs continuously.

The **Node application** is the whole application. It reads Tennis TV, applies the
domain rules, renders the Slack messages and sends them. It is short-lived: it starts,
performs one operation, and exits. GitHub Actions is what starts it.

The **Cloudflare Worker** exists for one reason — Slack needs a public HTTPS endpoint
to deliver button clicks to, and a short-lived process cannot provide one. It handles
the Opt In / Opt Out buttons and lends its D1 database to the Node application through
a small secured API. It does not touch Tennis TV and sends no Slack messages.

```
                ┌──────────────────────────────────────────────┐
  Tennis TV     │     short-lived Node process (GitHub Actions) │
  JSON API ────▶│                                              │──▶ Slack Web API
  (outbound)    │  tennistv/  ──▶  domain/  ──▶  slack/blocks/  │    (outbound)
                │  (provider)      (rules)       (rendering)    │
                └─────────────────────┬────────────────────────-┘
                                      │ state API (HTTPS, shared secret)
                                      ▼
                ┌──────────────────────────────────────────────┐
   Slack  ─────▶│             Cloudflare Worker                │
   buttons      │   /slack/interactions   ·   /api/...         │──▶ D1
   (inbound)    │   (signature-verified)      (state only)     │
                └──────────────────────────────────────────────┘
```

Neither runtime is ever idle-but-running. The Worker wakes for a request; the Node
application runs for the length of one operation. There is no permanent scheduler
loop, no Socket Mode connection, and no server to administer.

## 2. Module boundaries

```
src/
  main.ts              composition root: build config → logger → db → provider →
                       slack → scheduler → monitor; wire graceful shutdown.
  app.ts               assembled application object (start/stop), no I/O of its own.

  config/              Zod-validated environment. The ONLY module that reads
                       process.env. Exports a frozen typed `Config`.

  logging/             pino logger factory + request/job child-logger helpers.

  db/
    schema.ts          Kysely `Database` interface (table row types).
    client.ts          pool + Kysely instance + transaction helper.
    migrate.ts         Kysely migrator entry point.
    migrations/        numbered .ts migrations.
    repositories/      one file per aggregate: tournaments, matches, subscriptions,
                       outbox, schedule_runs. Repositories return DOMAIN types,
                       never raw rows.

  tennistv/
    provider.ts        the TennisTvProvider interface + domain-facing DTOs.
    endpoints.ts       Tennis TV's addresses. Defaults live here, not in config/,
                       so a host change is a one-module edit.
    http-provider.ts   the real implementation: paths, paging, caching, validation.
    http-client.ts     timeouts, retry budget, backoff, Retry-After, User-Agent.
    errors.ts          structured errors; `retryable` separates a blip from a
                       schema change.
    schemas.ts         Zod schemas for raw Tennis TV payloads.
    status-map.ts      raw status codes → normalised MatchStatus, built from
                       observed data rather than the front end's constants.
    mapper.ts          raw payload → domain object (times to UTC, TBC, availability).
    cache.ts           small TTL cache; no Redis, no cache validators available.
    fixture-provider.ts  replays recorded payloads from test/fixtures/.
    simulator-provider.ts  in-memory, admin-driven schedule for live testing (phase 7).
    index.ts           `createTennisTvProvider(config, logger)` factory.

  sync/
    sync-service.ts    tournament / schedule / live-state syncs, each wrapped in a
                       source_sync_runs row.
    windows.ts         the standing mirror window: enough for today, this week and
                       this month, and no more.
    polling-plan.ts    pure adaptive-polling policy over stored state.

  domain/
    types.ts           Tournament, Match, MatchState, TimeWindow, Transition.
    availability.ts    "is this shown on Tennis TV" rule (spec §9).
    match-state.ts     state machine: observed state → domain state → transition.
    windows.ts         today / this week / this month, Europe/London → UTC.
    format-time.ts     UTC instant → "19:04 UK" or "Time TBC".

  schedule/
    occurrences.ts     pure: which occurrences are due, their keys, windows and
                       grace bounds. All timezone reasoning lives here.
    summary-runner.ts  runs one occurrence idempotently, end to end.
    scheduler.ts       cron triggers, boot catch-up and the resilience sweep.

  monitor/
    monitor.ts         the self-rescheduling adaptive poll loop.
    alert-dispatcher.ts  transition → channel alert, or deliberate silence;
                       owns the retry path for undelivered alerts.

  slack/
    client.ts          Bolt app construction (Socket Mode), with a real auth check.
    message-service.ts the only sender: claim → post → settle, mass-mention ban,
                       dry run, startup reconciliation.
    blocks/            Block Kit builders — summaries, alerts, ephemeral replies.
    actions.ts         opt-in / opt-out button handlers.
    index.ts           assembles the above into one lifecycle object.

  admin/
    command.ts         `/tennis` parsing and the admin predicate. Pure.
    admin-handler.ts   executes subcommands; gates on ADMIN_SLACK_USER_IDS first.
    register.ts        thin Bolt adapter.

  simulation/
    simulation-service.ts  creates flagged simulated records and drives them through
                       the real transition and alert path.
```

### 2.1 Dependency rule

Dependencies point **inwards**, towards `domain/`:

```
config ──▶ (everything)
tennistv ──▶ domain           (provider emits domain DTOs)
db       ──▶ domain           (repositories return domain types)
schedule ──▶ domain, db, slack, tennistv(interface only)
monitor  ──▶ domain, db, slack, tennistv(interface only)
slack    ──▶ domain, db
domain   ──▶ nothing
```

`domain/` imports no Slack SDK, no database client, and no provider implementation.
`schedule/`, `monitor/` and `slack/` import `tennistv/provider.ts` (the interface)
and never `tennistv/http-provider.ts`.

**Enforced by test**, not by convention: a lint-style unit test greps the import
graph and fails if `slack/`, `schedule/`, `monitor/` or `domain/` reference the API
host, a Tennis TV field name, or `http-provider`.

### 2.2 File size

Soft cap ~250 lines per file. `blocks/` is split per message type so the biggest
formatting file stays small.

---

## 3. Main data flow

### 3.1 Scheduled summary

```
croner fires (08:00 Europe/London)
  └─▶ schedule/occurrences: resolve occurrence key, e.g. daily@2026-09-14
      └─▶ schedule/runner: claim the occurrence in `schedule_runs` (unique key)
          ├─ already completed?  → stop, log, no send
          └─▶ domain/windows: Europe/London window → UTC [from, to)
              └─▶ db/repositories/matches: read matches in window
                  └─ (stale? ) ─▶ TennisTvProvider.getSchedule(from, to) → upsert
                      └─▶ domain/availability: drop not-shown tournaments
                          └─▶ schedule/summaries: build view model
                              ├─ daily && empty → mark occurrence complete, send nothing
                              └─▶ slack/blocks + slack/publisher (idempotent send)
```

### 3.2 Live-state notification

```
monitor/poller tick (MONITOR_POLL_SECONDS)
  └─▶ TennisTvProvider.getLiveState() → observed matches (domain DTOs)
      ├─ provider error → backoff, DO NOT touch stored state
      └─▶ transaction:
            read stored match states
            └─▶ domain/match-state: previousState × observedState → Transition[]
                └─▶ persist new states + append match_state_events   (commit)
      └─▶ for each transition:
            └─▶ db/subscriptions: active subscriber IDs
                ├─ none → record as "suppressed, no subscribers", never re-emit
                └─▶ slack/blocks + slack/publisher (idempotent send)
```

### 3.3 Subscription toggle

```
Slack button (block_actions) over Socket Mode
  └─▶ slack/actions: extract user_id, desired state
      └─▶ db/subscriptions: UPSERT (slack_user_id) SET active = ?, updated_at = now()
          └─▶ respond_ephemeral("You're opted in." / "You're opted out.")
```

The upsert makes repeat clicks harmless by construction — there is no read-then-write
race and no error path for "already in that state".

---

## 4. Database responsibilities

> **Superseded.** This section described the PostgreSQL schema of the original
> always-on architecture. Production now uses **Cloudflare D1**, with three tables
> rather than seven, reached by the Node application through the state API. The current
> schema and the reasoning behind it are in §16.2; the history is in §17.
>
> The principle below is unchanged and still governs the design: the database is the
> only durable state, and the process holds no authoritative state in memory. That is
> what makes a run that is killed half-way through safe to repeat.

| Table | Owns | Key |
| --- | --- | --- |
| `subscriptions` | Per-user opt-in | PK `(team_id, channel_id, user_id)` |
| `match_state` | Last observed state per match | PK `match_key` |
| `notifications` | Idempotency ledger for every outbound post | PK `idempotency_key` |

What is deliberately **not** stored: the Tennis TV schedule. Tournaments and matches are
read fresh on every run rather than mirrored, which removes a whole class of "the copy
disagrees with the source" bugs and is affordable because a run reads only the window it
needs.

---

## 5. The Tennis TV provider boundary

### 5.1 The interface

```ts
export interface TennisTvProvider {
  /** Tournaments overlapping a local-date range. */
  getTournaments(range: DateRange): Promise<TournamentSnapshot>;

  /** Every match published for one tournament. Empty when the draw is not out. */
  getTournamentMatches(id: TournamentId): Promise<MatchSnapshot>;

  /** Current state of the given tournaments, never cached. */
  getLiveState(ids: readonly TournamentId[]): Promise<MatchSnapshot>;

  close(): void;
}
```

Three methods rather than the two originally sketched, because the source's
granularity is two-tier (§5.5): fetching tournaments and fetching matches have
different cadences, different costs and different failure meanings, so they are
different operations. Every snapshot carries `fetchedAt`, `fromCache` and `skipped` —
the last being records the response contained that failed validation, which is how a
partial schema drift announces itself before it becomes an outage.

Everything the rest of the system sees is a domain object: `ProviderTournament` and
`ProviderMatch` are the domain `Tournament` and `Match` plus the raw payload for
diagnostics. No `Status`, no `PulseStatus`, no `MatchDate`, no `notShown`, no
`account-id` — those names exist only inside `tennistv/`, and
`test/architecture/provider-boundary.test.ts` fails the build if they escape.

### 5.2 What the real implementation talks to

Reconnaissance (2026-09-14, `npm run recon`) established that `tennistv.com` renders
its schedule client-side from a **public JSON API** that the site's own bundle calls.
There is no need to scrape HTML and therefore **no need for Playwright** anywhere —
production or reconnaissance.

Full evidence, request/response shapes, limitations and unknowns are in
[`TENNISTV_DATA_SOURCE.md`](TENNISTV_DATA_SOURCE.md). The essentials:

| Detail | Value |
| --- | --- |
| Base | `https://api.tennistv.com/tennis/v1` |
| Required header | `account-id: 35` (a tenant selector, not a secret) |
| Tournaments | `GET /tournaments?from=&to=&size=&page=` — **`size` caps at 250**, so the provider pages |
| Tournament detail | `GET /tournaments/{id}/{year}` |
| Matches | `GET /matches?tournamentId={id}&year={year}` — both parameters required |
| Order of play | `GET /oop` — returned `[]` throughout; **not on the critical path** |

Three findings shape the design:

1. **Schedule granularity is two-tier** (§5.5). Tournaments are published months
   ahead; match records do not exist at all until the draw/order of play is out.
2. **Match identity must be composite** — `MatchId` is not globally unique (§4).
3. **The feed mixes two record shapes** in one `matches` array: a result record
   (`PulseStatus: "C"`, `PlayerTeam1`/`PlayerTeam2`, concrete time) and an
   order-of-play record (`PulseStatus: "U"`, `TeamsInMatch`, midnight `MatchDate` plus
   `NotBeforeISOTime`). The mapper normalises both.

`Status` is the truthful state field; `PulseStatus` says which representation a record
is, and the two can disagree. Unknown status codes must never be read as cancellation.

### 5.3 Mapping rules (`tennistv/mapper.ts`)

- **Time:** `MatchDate` is naive venue wall-clock with no zone. It is converted to UTC
  using `tournament.info.utcOffset` **from the payload**, never a constant. Where
  `NotBeforeISOTime` exists it carries its own explicit offset (`"10:00+0800"`) and is
  the better source. A missing `utcOffset` (1 of 81 tournaments) means the time is
  unknown, not assumed.
- **TBC:** `MatchDate` at `T00:00:00` means the start time is not published — the date
  is still known. A published time and a NotBefore time never co-occur. Of the
  NotBefore variants only `NotBeforeText: "Starts At"` is a real start time;
  `"Not Before"`, `"Followed By"` and an absent qualifier all map to `null` (TBC).
- **Availability:** `isShownOnTennisTv = !(tournament.metadata?.notShown === true)`.
  The marker is sparse — 6 of 81 tournaments carry it and 20 have no `metadata` at all
  — so absence means shown. A match-level marker is honoured if one ever appears.
- **State:** raw status → domain state in one table. Verified: `F`/`Finished` →
  `finished`, `CA` → `cancelled`, `WO` → `cancelled` (walkover). An absent `Status`
  falls back to `PulseStatus`. Unknown codes map to `'unknown'`, log at `warn`, and
  **emit no transition**.
- **Live and delayed states are not yet verified against data** (nothing was in play
  on the capture date). The mapping for them is written defensively and confirmed
  against a live tournament before phase 6 ships.

### 5.5 Schedule granularity — the two-tier model

Tennis TV publishes **tournaments** months ahead and **matches** only once the draw or
order of play exists. Nine days before Hangzhou and Chengdu, both returned zero
matches. This is modelled explicitly rather than worked around:

| | Tournament level | Match level |
| --- | --- | --- |
| Available | months ahead | once `availableOopDays` exists |
| Feeds | monthly + weekly summaries | daily summaries + live alerts |

`ScheduleSnapshot` therefore carries tournaments and matches as **separate
collections**, and a summary view model renders whichever level it has. The monthly
summary is a tournament schedule by nature; the daily summary is the only one that can
reliably be match-level. `PROJECT_SPEC.md` §4.2–4.3's "start times where known"
already allows for this.

`availableOopDays` on a tournament is the signal that match data exists — the poller
uses it to decide whether fetching matches is worthwhile.

### 5.4 Blast radius of a Tennis TV redesign

If Tennis TV changes its site or API, the files that need repair are
`tennistv/http-provider.ts`, `tennistv/schemas.ts` and `tennistv/mapper.ts`. The
recorded fixtures in `test/fixtures/` are re-captured, and the contract tests in
§9.3 tell us whether the domain DTOs still come out right. Nothing in `domain/`,
`schedule/`, `monitor/`, `slack/` or `db/` changes.

Zod validation at the provider edge means a schema drift surfaces as a loud,
attributable validation error rather than as `undefined` leaking into a Slack message.

---

## 6. The Slack boundary

- **Bolt for JavaScript in Socket Mode.** No public URL, no request-signature handling,
  no inbound port. Incoming webhooks are not used and could not be: the bot must
  *receive* button clicks, which a webhook cannot deliver, and a webhook would pin the
  destination to whatever channel was chosen at install time rather than to config.
- `slack/client.ts` is the only module that constructs the Bolt app or a `WebClient`.
  It defers Bolt's initialisation so that an invalid token becomes a clear startup
  failure naming the variable to fix, rather than an unhandled rejection.
- `slack/message-service.ts` is the only module that calls `chat.postMessage` or
  `chat.postEphemeral`. Concentrating sends there is what makes the safety rules
  enforceable rather than merely intended:
  - it **rejects** any payload whose rendered text contains `@channel`, `@here` or
    `@everyone` — a thrown error, not a silent strip, so a formatting bug fails in
    tests instead of pinging a workspace;
  - it **refuses any DM target**: the channel is read from `SLACK_CHANNEL_ID` inside
    the service, never passed by a caller, so no code path can post elsewhere;
  - it honours `SLACK_DRY_RUN`;
  - it claims in Postgres before posting, and attaches the idempotency key as Slack
    message `metadata` so startup reconciliation can resolve an interrupted send (§8);
  - reconciliation that cannot read channel history leaves claims **pending** rather
    than abandoning them — "we do not know" is not "it was not delivered".
- `slack/blocks/` builds Block Kit from view models with pure functions, which is why
  every message-shape rule is a fast unit test. `npm run preview:messages` renders all
  of them to the terminal for design review.
- Mentions are rendered as `<@U…>` from stored subscriber IDs only. An alert builder
  **throws** rather than render with no recipients, so "nobody opted in means post
  nothing" cannot be forgotten at a call site.

### 6.1 Required Slack scopes

Two bot scopes: `chat:write` (summaries, alerts, ephemeral confirmations) and
`channels:history` (startup reconciliation; `groups:history` for a private channel),
plus `connections:write` on the app-level token.

Deliberately not requested: `users:read` (mentions come from stored IDs), `im:write`
(the bot never DMs, and not holding the scope makes that structural), `channels:read`,
and any event subscription. `commands` arrives with the admin phase.

The manifest is [`slack-app-manifest.yaml`](../slack-app-manifest.yaml); setup and the
full rationale are in [`SLACK_SETUP.md`](SLACK_SETUP.md).

---

## 7. Scheduling model

Reports must not depend on a timer being alive at 08:00. The design therefore has
**three independent ways to do the same work**, all routed through one idempotent
runner:

| Route | Purpose |
| --- | --- |
| `croner` jobs at 08:00 `APP_TIMEZONE` | punctuality |
| a catch-up on boot | a deploy or crash around 08:00 costs a few minutes, not a report |
| a sweep every 10 minutes | a missed timer — suspended process, clock jump, misfire — is noticed in minutes |

Any one can fail without losing a report; all three together cannot send one twice.

### 7.1 Occurrences

Every trigger resolves to an **occurrence**: a kind plus the local calendar date it
belongs to — `DAILY/2026-09-15`, `WEEKLY/2026-09-14` (that week's Monday),
`MONTHLY/2026-09-01`. Whether it still needs doing is a question for
`scheduled_summary_runs`, never for whether a timer fired.

`src/schedule/occurrences.ts` is pure — no I/O, no `Date.now()`, no timers. It takes
the current instant explicitly, which is what makes every DST and catch-up case
testable by choosing an instant rather than mocking a clock.

### 7.2 Catch-up and its bound

`dueOccurrences(now)` returns everything whose 08:00 has passed and whose period is
still current. A **grace window** bounds it: the same local day, week or month. So a
weekly missed on Monday still sends on Wednesday — the week it describes is current —
but never the following Monday, and yesterday's daily is never sent today.

The trade-off is deliberate: a daily caught up at 20:00 is a little stale, but it is
factually correct and better than silence. What must never happen is reporting a period
that has closed.

### 7.3 Concurrency

Two guards, in that order of importance:

1. **The database claim.** `claimOccurrence` is an `INSERT … ON CONFLICT DO UPDATE …
   WHERE`, so whichever tick loses the race matches nothing and gets no row. This
   covers two processes, not just two timers.
2. **An in-process flag** stopping a tick starting while the previous one runs. An
   optimisation only — it prevents pointless work, not duplicates.

A RUNNING claim older than 15 minutes is re-claimable, because a process killed
mid-run would otherwise leave an occurrence that never runs again. That is safe
because the *message* is independently guarded (§8), so a retry that already posted
sends nothing.

### 7.4 Independence

Daily, weekly and monthly are separate requirements. On a Monday that is also the 1st,
all three run; the daily staying silent on an empty day does not suppress the other
two, and one failing does not prevent the others (`PROJECT_SPEC.md` §4).

### 7.5 Time

Luxon over IANA `Europe/London` throughout, and croner resolves its expressions against
the same zone. No offset is computed, compared or written down — 08:00 local is 08:00
UTC in winter and 07:00 UTC in summer because the zone database says so, including on
the 23- and 25-hour transition days.

---

## 8. Idempotency strategy

Two independent ledgers, both enforced by Postgres unique constraints rather than by
in-process state, so they hold across restarts and across two instances running at
once.

### 8.1 Scheduled jobs — `schedule_runs`

`UNIQUE (kind, occurrence_date)`. The runner does
`INSERT … ON CONFLICT DO NOTHING RETURNING *`; no row returned means somebody else
owns this occurrence and we stop. Outcome is recorded as `posted`, `skipped_empty`
(the daily-with-no-matches case, which is a successful completion, not a failure) or
`failed` (retryable within the grace window).

### 8.2 Outbound messages — `sent_messages`

Every message has a **deterministic** idempotency key derived from its meaning, not
from a timestamp or a UUID:

```
summary:daily:2026-09-14
summary:weekly:2026-09-14
summary:monthly:2026-09-01
match:ATP1234MS01:live
match:ATP1234MS01:delayed
match:ATP1234MS01:cancelled
```

The send is **claim → post → settle**:

1. `INSERT INTO sent_messages (idempotency_key, status) VALUES (…, 'pending')
   ON CONFLICT DO NOTHING`. No row → already claimed or already sent → return.
2. `chat.postMessage`, with the key in Slack message `metadata`.
3. `UPDATE … SET status='sent', slack_ts=…`.

Claiming before posting is deliberate: a crash between 1 and 2 loses a message rather
than duplicating one, which is the direction spec §10 requires.

### 8.3 Narrowing the crash window — startup reconciliation

On boot, any `pending` row older than a short threshold is reconciled against reality
rather than guessed at: the publisher reads recent `conversations.history` for
`SLACK_CHANNEL_ID` and matches the idempotency key carried in each message's
`metadata`.

- **Found** → mark `sent`: the post succeeded and only the bookkeeping was interrupted.
- **Not found, claimed recently** → *release the claim*. The channel was read and the
  key is definitively absent, so releasing cannot duplicate — and the normal retry then
  rebuilds and sends it. Without this step a transient Slack error would cost the
  message permanently even though nothing was ever delivered.
- **Not found, but old** → mark `abandoned`. Beyond the history window, "not found"
  could mean "scrolled past", and we will not risk the one thing we must never do.
- **History unreadable** → change nothing. "We do not know" is not "it was not
  delivered"; the claims stay pending for the next attempt.

This turns "we might have lost a message" into "we know whether we lost a message",
using nothing but Slack itself. No Redis, no outbox worker.

### 8.4 Live transitions

Transitions are derived from persisted previous state, so the ledger and the state
machine agree by construction. A transition that is suppressed because nobody is
subscribed is still recorded in `match_state_events` with `notified = false` and its
`sent_messages` key settled as `abandoned`, so a later subscriber never receives a
backlog of stale alerts.

---

## 9. Monitoring model

### 9.1 Detection

One poll of `/matches` for the tournaments running today. Observed states are compared
with stored ones **inside a single transaction**, so two pollers cannot both see the
same transition and a crash rolls back the state and the event together.

Detection is expressed in `domain/match-state.ts` as a pure function over normalised
statuses, which is why the whole matrix (PROJECT_SPEC.md §6.3) is a fast unit test.

Three things can never produce an alert, and each has a test named after it:

- a match **disappearing** from the response — absence is "not observed";
- a scheduled start **passing** with nothing changed — the clock is never consulted;
- an **unrecognised status** — `UNKNOWN` is inert in both directions.

A delay is inferred from an explicit provider status, or from a published start time
being **republished more than `MONITOR_SCHEDULE_SLIP_MINUTES` later** while the match
is still upcoming. That reacts to Tennis TV changing its data, never to time passing.

### 9.2 Delivery

`monitor/alert-dispatcher.ts` owns the rule that matters most: alerts go to the **same
configured channel**, never a DM, mentioning **only** the currently opted-in users,
read at send time rather than detection time.

With **no subscribers**, the state is persisted and **nothing is posted**. The event is
marked delivered anyway, which is what stops the transition being replayed to whoever
subscribes next.

### 9.3 Surviving a delivery failure

Detection and delivery are **separate records**, and that separation is the whole
design. A transition is detected once and can never be re-detected — the next poll sees
the same state and correctly says nothing — so without a delivery record a single Slack
error would lose the alert permanently.

| Situation | Behaviour |
| --- | --- |
| Post succeeds | event marked delivered |
| Post fails | event left undelivered; the claim stays pending |
| Retry sweep, claim released by reconciliation | rebuilt and sent |
| Retry sweep, claim still pending | left alone — a pending claim is *not* proof of delivery |
| Older than `MONITOR_ALERT_RETRY_MINUTES` | abandoned; an alert about a match that started an hour ago is noise |

That bounds both failure modes the specification names: it cannot spam duplicates (the
idempotency key is unique in Postgres), and it cannot permanently lose a notification
after one transient error (the undelivered event is retried).

### 9.4 Adaptive polling

The interval is re-planned from stored state after **every** poll, and all four
cadences are configuration:

| Situation | Setting | Default |
| --- | --- | --- |
| A match is live or delayed, or a start is imminent | `MONITOR_POLL_SECONDS` | 60s |
| Matches today, none live or imminent | `MONITOR_MATCH_DAY_POLL_SECONDS` | 300s |
| Tournament on, order of play not published | `MONITOR_TOURNAMENT_POLL_SECONDS` | 900s |
| Nothing on — **no request is made at all** | `MONITOR_IDLE_POLL_SECONDS` | 1800s |

The idle case is the important one: most of the year there is no ATP tennis, and the
access agreement asks us not to make requests we do not need (PROJECT_SPEC.md §2). On
the reconnaissance date the monitor would have made **zero** provider requests.

The loop reschedules itself rather than using a fixed interval, so a slow poll cannot
queue work behind itself, and an in-process guard skips an overlapping cycle.

---

## 10. Test strategy

Vitest throughout, in three layers separated by what each one needs. The filename is
the contract:

| Pattern | Needs | Script |
| --- | --- | --- |
| `*.test.ts` | nothing — fixtures and fakes | `npm run test:fast` |
| `*.int.test.ts` | Postgres | `npm run test:int` |
| `upstream-contract.test.ts` | the live Tennis TV API | `npm run test:contract` |

`npm test` runs the first two. **Ordinary CI never touches Tennis TV**, so an upstream
outage cannot turn the build red; the contract test belongs on a schedule, where a
failure is a real signal about Tennis TV rather than noise on a pull request.

Two rules hold everywhere: **injected clocks, never sleeping** (`setTimeout` appears in
no test), and **fixtures, never the live site** outside the contract layer.

### What each layer covers

| Layer | Covers |
| --- | --- |
| **Pure unit** | the domain — DST and window arithmetic, TBC, availability, the transition matrix; message shapes; occurrence keys and grace bounds |
| **Provider** | mapping real captured payloads; malformed, truncated and drifted responses; retry, backoff and timeout policy; caching |
| **Integration** | repositories against real Postgres; scheduling and catch-up; live alerting; subscriptions and buttons; simulation and admin permissions; resilience and lifecycle |
| **Contract** | the live API still matches what the provider understands |

### Behaviours that get their own named test

Because each is a rule the specification states, not an implementation detail:

- every rendered message contains none of `@channel`, `@here`, `@everyone`;
- a daily with no matches makes **zero** Slack calls;
- opt in ×3 then opt out ×3 leaves the user opted out, with no errors;
- zero subscribers means no alert, and no replay to a later subscriber;
- a subscriber who opts out **before** a match begins is not mentioned;
- an application restart while a match is live re-announces nothing;
- a database restart mid-poll changes no state and recovers on the next cycle;
- a re-run occurrence after a crash posts exactly once;
- summaries spanning both 2026 DST transitions show correct UK times;
- a provider returning 500s, timeouts, `[]`, or a changed schema leaves stored state
  and subscriptions intact — and never posts to Slack;
- a non-admin can run no simulation and is not shown the subcommands;
- simulated records never appear in a real summary or alert;
- the import-graph test keeping Tennis TV knowledge inside `tennistv/`;
- committed fixtures carry no credentials or personal data.

Fixtures are captured from the live API by `npm run recon` and committed, so the suite
is deterministic and runs offline.

---

## 11. Deployment assumptions

> Superseded by §15. Kept because the reasoning about idempotency, timezone handling and
> secret management still applies; only the hosting does not.

- **Nothing runs continuously.** The Node application is started by GitHub Actions,
  performs one operation and exits. The Cloudflare Worker wakes for a request. There is
  no VPS, no Railway, no always-on PC, and no production Docker requirement.
- **Concurrency is survivable, not prevented.** Two overlapping runs would not duplicate
  messages — §8 is enforced by a database primary key, not by memory — though the second
  would waste Tennis TV requests.
- **State lives in Cloudflare D1**, reached by the Node application through the state
  API (§16). Production no longer requires PostgreSQL.
- Config via environment variables; secrets from the platform's secret store, never
  committed. `.env` is git-ignored; `.env.example` documents the full set.
- Logs are structured JSON on stdout, collected by the platform — GitHub Actions' run
  log for the Node application, `wrangler tail` for the Worker. `LOG_LEVEL` controls
  verbosity; no secrets or tokens are ever logged.
- Timezone: the runner's clock is UTC; `APP_TIMEZONE` governs all display and
  scheduling, so the host timezone is irrelevant. Cron expressions are UTC and are only
  a trigger — what is actually *due* is decided in `Europe/London` by §7.
- Resource profile is negligible: a few seconds of runner time per execution, and a D1
  database holding three small tables.

---

## 12. Implementation phases

> **Historical.** This was the build order for v1, and several phases describe
> components that were later replaced — the Bolt/Socket Mode Slack layer, the PostgreSQL
> persistence layer, and the in-process scheduler. It is kept as a record of how the
> system was assembled, not as a description of what exists. §15 is the current shape.

| Phase | Deliverable | Status |
| --- | --- | --- |
| **0** | Scaffold, spec, architecture | current |
| **1** | `config/`, `logging/`, persistence | persistence replaced by D1 (§16) |
| **2** | `domain/` — types, windows, DST, TBC, availability, state machine | current, unchanged |
| **3** | `tennistv/` — interface, schemas, HTTP provider, mapper, fixtures | current, unchanged |
| **4** | `slack/` — publisher with idempotency and safety rules, block builders | current; the Bolt/Socket Mode transport was replaced |
| **5** | `schedule/` — occurrences and the three reports | current; the in-process runner became a GitHub Actions job |
| **6** | `monitor/` — polling and live alerts | current; polling became a 30-minute workflow |
| **7** | Simulation mode | current; the `/tennis` command became a `workflow_dispatch` |
| **8** | Deployment | current: Cloudflare Worker + GitHub Actions (`docs/SETUP_FROM_SCRATCH.md`) |

---

## 13. Requirements sanity check

Every requirement in `PROJECT_SPEC.md` mapped to where this architecture satisfies it.

| Spec | Requirement | Satisfied by |
| --- | --- | --- |
| §4.1 | Daily 08:00, post only if matches | §7 cron + §3.1; `skipped_empty` outcome |
| §4.2 | Weekly Monday 08:00, always post | §7 `0 8 * * 1`, summaries always render |
| §4.3 | Monthly 1st 08:00, always post | §7 `0 8 1 * *` |
| §4.2–4.3 | Dates + UK-local times | §3.1 windows + `domain/format-time.ts` |
| §5 | Opt in/out buttons on summaries | `slack/blocks/`, `slack/actions.ts` |
| §5 | Per-user, ephemeral, repeat-safe | `subscriptions` PK + UPSERT (§3.3) |
| §6 | Live/delayed/cancelled alerts | §9 transition table |
| §6.1 | Never DMs; same channel | publisher reads channel from config (§6) |
| §6.1 | Mention only opted-in users | §3.2 subscriber read at send time |
| §6.1 | Nobody opted in → no post | §3.2 suppression + §8.4 no replay |
| §6.1 | Never @channel/@here/@everyone | publisher throws (§6); asserted per message (§10) |
| §7 | UTC canonical, Europe/London display | `timestamptz` columns (§4), Luxon (§7) |
| §7 | GMT/BST automatic, no hard-coded offset | IANA zone only; DST tests (§10) |
| §8 | Never guess; show `Time TBC` | `scheduled_start_utc NULL` (§4), mapper rule (§5.3) |
| §8 | Updates when published | hourly schedule refresh (§9) |
| §9 | Exclude not-shown tournaments | `metadata.notShown` → `isShownOnTennisTv` (§5.2–5.3), filtered in `domain/availability.ts` |
| §10 | No duplicate alerts or summaries | §8.1 + §8.2 unique keys |
| §10 | Restarts don't duplicate | Postgres-enforced, not in-memory (§8) |
| §11 | Provider/network/Slack failure safe | §9 backoff, no-mutate-on-failure; §8.3 reconciliation |
| §11 | Restart doesn't corrupt state | transactional writes (§4), append-only events |
| §12 | Full simulation mode | §2 `simulator-provider` + `admin/`, phase 7 |
| §13 | Nothing hard-coded | `config/` sole env reader, `.env.example` |
| §14 | Node LTS/TS/Bolt/Socket/Postgres/Zod/pino/Vitest | §1, §2, §10, `package.json` |
| §14 | Playwright only if genuinely required | §10 — not required; API-backed provider |
| §15 | Provider interface; no HTML knowledge outside it | §5, enforced by import-graph test (§2.1) |
| §15 | Simple, boring, no microservices/Redis | §1, §11 |

No requirement is unaddressed.

---

## 14. Reconnaissance backlog

Reconnaissance ran on 2026-09-14 (`npm run recon`). Findings are in
[`TENNISTV_DATA_SOURCE.md`](TENNISTV_DATA_SOURCE.md). Status of the original eight:

| # | Question | Status |
| --- | --- | --- |
| 1 | TBC representation | **Resolved** — midnight `MatchDate`; `NotBeforeText` qualifies (§5.3) |
| 2 | Real status vocabulary | **Partly resolved** — `F`/`Finished`/`CA`/`WO`/absent observed; terminal states only |
| 3 | How "delayed" is signalled | **Open** — nothing was in play on the capture date |
| 4 | Which endpoint drives the monitor | **Resolved** — `/matches?tournamentId&year`; `/oop` never seen populated |
| 5 | Per-match availability | **Resolved enough** — availability is tournament-level; no match-level marker in 1868 records |
| 6 | API stability and rate expectations | **Open** — no published contract or rate limit |
| 7 | Doubles, qualifying, non-ATP events | **Open — product question**, not a data one |
| 8 | Slack workspace specifics | **Open** — needs the channel before phase 4 |

Newly opened by reconnaissance:

9. **How many days before a tournament do matches appear?** Measured only as "more
   than 9 days out is too early". Hangzhou and Chengdu start 2026-09-23, so running
   `npm run recon` daily until then answers it exactly. This decides whether the 08:00
   daily summary reliably sees day-1 order of play for tournaments starting overnight
   in Asia.

10. **Live and delayed state have never been observed.** `PulseStatus: "L"` and the
    in-play `Status` codes are declared by the front end but unverified. Phase 6 must
    not ship without a capture from a live tournament day.
    *Safe default:* unknown codes map to `unknown` and emit no transition.


---

## 15. Runtime topology

Where each responsibility actually executes.

| Responsibility | Runs in | Why there |
| --- | --- | --- |
| Reading Tennis TV (`tennistv/`) | Node, on GitHub Actions | The proven implementation. A runner can use any Node capability the job needs, with no runtime restrictions to design around. |
| Domain rules (`domain/`) | Node | Pure; no reason to be anywhere else. |
| Daily / weekly / monthly reports | Node | Needs Tennis TV data and full rendering. |
| Live monitoring, every 30 minutes | Node, on a GitHub Actions schedule | Needs Tennis TV data. |
| Outgoing Slack messages | Node, via Slack's Web API | Follows the data. No inbound connection needed to send. |
| Opt In / Opt Out buttons | Cloudflare Worker | Slack must reach a public HTTPS URL. This is the *only* thing that genuinely requires an always-available endpoint. |
| Subscriptions, match state, dedupe records | Cloudflare D1, via the Worker | The three things a short-lived process cannot recompute. |

What is deliberately **not** in Cloudflare: Tennis TV access, match monitoring, report
generation, scheduled Slack messages, and any Cron Trigger. `wrangler.jsonc` has no
`triggers` block, and that absence is the architecture.

What is deliberately **not** anywhere: PostgreSQL, Socket Mode, a permanent scheduler,
and any always-on host.

### 15.1 The workflows

| Workflow | Schedule (UTC) | Purpose |
| --- | --- | --- |
| `tennis-monitor.yml` | `7,37 * * * *` — every 30 minutes, all day | Live-state checks |
| `tennis-morning.yml` | `0 7 * * *` and `0 8 * * *` | Daily, weekly and monthly reports |
| `ci.yml` | on push / PR | Format, lint, typecheck, test, build |

Both production workflows also accept `workflow_dispatch`, with a `dry_run` input that
exercises the whole path and logs the Slack message instead of sending it.

The monitor's offset minutes (`:07`/`:37` rather than `:00`/`:30`) avoid GitHub's
heaviest scheduling congestion, which routinely delays on-the-hour runs. The interval is
still exactly 30 minutes.

**The morning workflow fires twice, and that is the timezone handling.** GitHub Actions
cron has no timezone support — it is UTC only. Rather than hard-code a seasonal offset,
which would silently break twice a year, both 07:00 and 08:00 UTC run the same command,
and the command asks Luxon which one is 08:00 in `Europe/London`:

| | 07:00 UTC | 08:00 UTC |
| --- | --- | --- |
| **BST** | 08:00 London — posts | 09:00 London — already sent, does nothing |
| **GMT** | 07:00 London — not due, does nothing | 08:00 London — posts |

Exactly one posts, because the report key is claimed in D1 and can only be claimed once.
A missed run self-heals: if 07:00 never happens, 08:00 finds the report outstanding and
sends it. No offset is written down anywhere, and the DST changeover weekends need no
special handling.

### 15.2 GitHub Secrets and Variables

Secrets are masked in logs and never printed. Variables are not secret and are visible
in the workflow run.

| Name | Kind | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Secret | `xoxb-…`, to post messages |
| `INTERNAL_API_SECRET` | Secret | Bearer token for the Worker's state API |
| `SLACK_CHANNEL_ID` | Variable | The one channel for summaries and alerts |
| `STATE_API_URL` | Variable | Base URL of the deployed Worker |
| `APP_TIMEZONE` | Variable | Optional; defaults to `Europe/London` |
| `TENNISTV_BASE_URL` | Variable | Optional; defaults to the public site |
| `LOG_LEVEL` | Variable | Optional; defaults to `info` |

Every optional variable may be left unset. GitHub renders an unset variable as an
**empty string** rather than omitting it, so `loadConfig` treats blank as absent — that
is what makes them genuinely optional rather than a trap.

There is no Tennis TV credential. The API is public and is read with an `account-id`
header, which is not a secret (docs/TENNISTV_DATA_SOURCE.md §3).

---

## 16. The state API

The Node application runs on a machine that keeps nothing between executions, so it
needs somewhere to put the three things it cannot recompute from Tennis TV:

1. **who is opted in** — exists nowhere else;
2. **what each match looked like last time** — the basis of every transition decision
   (§9.1). Without it, every run would rediscover each live match and alert again;
3. **what has already been sent** — the basis of every duplicate decision (§8).

The Worker exposes these over HTTPS, authorised by a single shared secret held as a
Cloudflare secret and a GitHub Actions secret. D1 credentials are never exposed; the
runner cannot reach the database except through these endpoints.

| Endpoint | Purpose |
| --- | --- |
| `GET  /api/subscribers?channel=` | Slack user IDs to mention |
| `POST /api/match-state/load` | Previous state for a list of match keys |
| `POST /api/match-state/save` | Record what this run observed |
| `POST /api/notifications/claim` | Become the sender of one idempotency key |
| `POST /api/notifications/settle` | Record sent / suppressed / failed / abandoned |
| `POST /api/notifications/status` | Whether report keys are already settled |
| `POST /api/maintenance/prune` | Retention sweep |

The API is deliberately dumb. It stores and returns; it makes no decisions, knows
nothing about Tennis TV or Slack, and never parses the keys it is given — they are
opaque strings. Everything that decides lives in the Node application, where it is
unit-tested without a network.

Keys are formed by `src/schedule/report-keys.ts` (`daily:2026-09-14`, `weekly:2026-W38`,
`monthly:2026-09`) and, for alerts, from the match's stable composite identity plus the
status reached (`4713:2026:MS011:LIVE`).

### 16.1 Authentication

One shared secret, `INTERNAL_API_SECRET`, held as a Cloudflare Worker secret and as a
GitHub Actions secret. The runner presents it as `Authorization: Bearer …`.

- **Never in a URL.** Query strings are logged by proxies and land in browser history.
- **Never logged.** Neither side prints it, and the configuration error messages name
  variables rather than values.
- **Compared in constant time.** `===` returns at the first differing byte, which leaks
  how much of a guessed token was right.
- **Absent means closed.** When the secret is not configured, every `/api/` route
  answers 404 rather than running unauthenticated. A disabled endpoint should not even
  admit to existing.
- **Scoped to these endpoints.** This is the only credential GitHub ever holds for
  Cloudflare. It grants the seven operations below and nothing else — no Cloudflare API
  token, no D1 binding, no account access. If it leaked, the blast radius is this
  artefact's own state.

There is no SQL endpoint. Every route takes a typed, Zod-validated body and every value
reaches SQLite as a bound parameter, so a key containing `'; DROP TABLE …` is stored as
the string it is. `test/worker/internal-api-e2e.test.ts` asserts both.

### 16.2 The D1 schema, and what was left out

Four tables were considered. Three exist.

| Candidate | Verdict |
| --- | --- |
| `subscriptions` | **Kept.** Who is opted in exists nowhere else — not in Tennis TV, not derivable from Slack. |
| `match_state` | **Kept.** The `previous` half of every transition decision. Without it a stateless runner would rediscover each live match every 30 minutes and alert again. |
| `notification_events` | **Kept, merged.** See below. |
| `scheduled_reports` | **Merged into `notifications`.** See below. |

**Why one ledger rather than two.** A match alert and a scheduled report are the same
problem — "post this exactly once" — differing only in how the key is spelled:

```
ALERT    4713:2026:MS011:LIVE        match identity + the status reached
REPORT   daily:2026-09-14            the occurrence it belongs to
```

Both are enforced by the same primary key, claimed by the same statement and settled by
the same one. Two tables would have meant duplicating the claim/settle logic — including
the lease and the attempt ceiling — for no behavioural gain, and two places for that
logic to drift. A `kind` column records which is which for diagnostics.

**Uniqueness.** `subscriptions` is keyed on `(team_id, channel_id, user_id)`, which is
what makes a repeated button click collide with itself and update rather than insert.
`notifications` is keyed on `idempotency_key`, which delivers both "match ID + status is
unique" and "report key is unique". `match_state` is keyed on the composite match key.
All three are `WITHOUT ROWID`: every access is by primary key, so the extra indirection
of a rowid table would be pure cost.

**Indexes.** Three, each backing a query that actually exists: recipients by channel,
match state by age (retention), notifications by status and age (retention). No
speculative indexes.

**Delivery states.** `PENDING → SENT` is the main path. `SUPPRESSED` records a decision
not to send — a dry run, or a daily report on a day with no matches — so the decision is
not revisited every run; `ABANDONED` stops a permanently failing message retrying
forever. All four are terminal except `PENDING`.

**The lease.** A claim is respected for ten minutes. After that another run may take it
over, incrementing an attempt counter, up to five attempts. That is the whole recovery
mechanism: a runner that claims an alert and is then killed mid-delivery does not lose
the alert, and does not retry it forever either. Before re-sending a claim with
`attempts > 1`, the publisher checks the channel's own history for the idempotency key,
which closes the window where "we never heard back from Slack" could have meant "it
actually landed".

---

## 17. Architecture history

The runtime has changed twice. Both changes were driven by the same requirement —
**£0 ongoing cost and no always-on machine** — and the record is kept here because the
reasoning matters more than the outcome.

### 17.1 Original: one long-running Node process + PostgreSQL

Phases 1–10 built a single always-on process using Socket Mode for Slack and PostgreSQL
for state, with an in-process cron. Correct, well-tested, and it needed a host that runs
continuously — which is what made it unsuitable.

### 17.2 Explored and abandoned: all-Cloudflare

An all-Cloudflare production architecture was then explored: a Worker doing everything,
on a 20-minute Cron Trigger, with D1 for state.

The compatibility question was answered properly rather than assumed, and the answer was
**yes** — the Tennis TV provider is plain `fetch` against a public JSON API, with no
browser anywhere, and the whole Worker bundled at 126 KB gzipped with no `nodejs_compat`
flag. That finding is recorded in
[`CLOUDFLARE_COMPATIBILITY.md`](CLOUDFLARE_COMPATIBILITY.md) and remains true.

**It was abandoned anyway.** Technical feasibility was never the objection. Putting the
whole application inside a Worker means the production runtime is permanently
constrained by what `workerd` supports — a constraint with no upside here, since the
schedule is measured in tens of minutes and nothing needs edge latency. It also placed
Tennis TV access, the domain rules and the reports in an environment the test suite
cannot exercise directly, in exchange for nothing the requirements asked for.

### 17.3 Current: GitHub Actions + Cloudflare for interactivity and state

The Node application returns to being the application, run in short bursts by GitHub
Actions — free, no host to administer, and unrestricted in what it may use. Cloudflare
keeps exactly the two jobs that genuinely need an always-available endpoint: receiving
Slack button clicks, and holding the small amount of state a stateless runner cannot
keep.

The pieces built during 17.2 that survived — signature verification with replay
protection, the button handling, the D1 schema and its repositories, the Worker
scaffolding — survived because they belong to those two jobs. The pieces that made
Cloudflare the application runtime were removed.
