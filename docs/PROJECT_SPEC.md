# TTV Calendar Bot — Project Specification

**Status:** authoritative. This document is the durable source of truth for what the
bot must do. If an instruction elsewhere (a prompt, a comment, a ticket) contradicts
this file, this file wins until it is deliberately amended here.

**Last updated:** 2026-09-14

---

## 1. Purpose

A Slack bot that tells a QA/testing team when Tennis TV has live tennis available to
test against, so testers do not have to watch the schedule themselves.

The bot answers two questions:

1. *"Is there tennis on Tennis TV today / this week / this month?"* — scheduled summaries.
2. *"Is something happening right now that I can test against?"* — live-state alerts.

## 2. Authorisation

We have explicit approval from Tennis TV for this project and for the Tennis TV data
access it requires. All access must remain polite and low-volume: conservative polling
intervals, caching, honest `User-Agent`, and backoff on errors. The approval covers
reading schedule data for this internal tool; it is not a licence to redistribute
Tennis TV content.

## 3. Glossary

| Term | Meaning |
| --- | --- |
| **Tournament** | A Tennis TV event with a start and end date, e.g. "ATP Cincinnati". |
| **Match** | A single scheduled or in-progress match within a tournament. |
| **Shown on Tennis TV** | A tournament/match Tennis TV is not explicitly marking as unavailable on its platform. |
| **Summary** | A scheduled daily/weekly/monthly schedule post. |
| **Live-state notification** | An ad-hoc post triggered by a match becoming live, delayed, or cancelled. |
| **Subscriber** | A Slack user currently opted in to live-state notifications. |
| **Occurrence** | One specific firing of a scheduled job, identified by its local date (e.g. `daily@2026-09-14`). |

---

## 4. Scheduled summaries

All scheduled posts go to `SLACK_CHANNEL_ID`, at **08:00 in `APP_TIMEZONE`
(Europe/London)**.

### 4.1 Daily

- Runs every day at 08:00 Europe/London.
- Scope: matches scheduled **today** (Europe/London calendar day).
- **If there are one or more matches today → post a summary.**
- **If there are no matches today → post absolutely nothing.** No "nothing on today"
  message, no placeholder, no reaction.

### 4.2 Weekly

- Runs every **Monday** at 08:00 Europe/London.
- Scope: Monday 00:00 → Sunday 23:59:59 Europe/London of the current week.
- **Always posts, including when there are no matches** (in which case it explicitly
  says so).
- Must include dates and UK-local start times where known.

### 4.3 Monthly

- Runs on the **first day of every month** at 08:00 Europe/London.
- Scope: the 1st 00:00 → last day 23:59:59 Europe/London of the current month.
- **Always posts, including when there are no matches.**
- Must include dates and UK-local start times where known.

### 4.4 Overlap

When a date is simultaneously daily, weekly and monthly (e.g. Monday 1 June), all
three posts are sent. They are separate, independently idempotent messages.

---

## 5. Notification subscriptions

Every scheduled summary message must carry two interactive buttons:

- `🔔 Opt in to live alerts`
- `🔕 Opt out of live alerts`

Rules:

- Subscription state is **per Slack user**, global to the bot (not per message, not
  per tournament).
- Clicking either button gives that user an **ephemeral** confirmation, visible only
  to them.
- Clicking **opt in** when already opted in is harmless and idempotent — it confirms
  again and changes nothing.
- Clicking **opt out** when already opted out is harmless and idempotent.
- Buttons on old messages must keep working; a button click is interpreted purely as
  "set this user's subscription to X", never relative to the message's age.

---

## 6. Live-state notifications

The bot monitors Tennis TV for match state changes and posts when a match:

| Transition | Trigger |
| --- | --- |
| **Starts / becomes live** | The match enters any in-play state. |
| **Is delayed** | The match's start is pushed back, or play is suspended. |
| **Is cancelled** | The match will not be played. |

### 6.1 Delivery rules (hard requirements)

- Live-state notifications **MUST NOT be sent as DMs.**
- They are posted to the **same** `SLACK_CHANNEL_ID` as the summaries.
- The post **@mentions only users currently opted in**, by Slack user ID.
- **If nobody is opted in, do not post a live-state notification at all.** The state
  change is still recorded so it is never re-emitted later.
- **Never use `@channel`, `@here` or `@everyone`.** Not in summaries, not in alerts,
  not in error messages, not in simulation mode.

### 6.2 Message shape

```
🔴 LIVE — Sinner vs Alcaraz
ATP Cincinnati
Started: 19:04 UK

<@U123ABC> <@U456DEF>
```

Delayed and cancelled notifications follow the same structure with an appropriate
icon and leading line, and state the reason where Tennis TV gives one.

### 6.3 Transition semantics

Alerts fire on **real state transitions only**. The full matrix:

| From | To | Alert |
| --- | --- | --- |
| `SCHEDULED` | `LIVE` | 🔴 live |
| `DELAYED` | `LIVE` | 🔴 live — a resumed match is news |
| `SCHEDULED` | `DELAYED` | ⏸️ delayed |
| `LIVE` | `DELAYED` | ⏸️ delayed (suspended mid-match) |
| `SCHEDULED` / `LIVE` / `DELAYED` | `CANCELLED` | ❌ cancelled |
| any | same status again | nothing |
| any | `COMPLETED` | nothing |
| any | `UNKNOWN`, or `UNKNOWN` | nothing |
| `CANCELLED` / `COMPLETED` | anything | nothing — terminal |

- A **repeated observation is not a transition**: `LIVE → LIVE` and
  `DELAYED → DELAYED` are silent, so a restart while a match is still live re-observes
  the same state and says nothing.
- Transitions are computed from **stored previous state vs newly observed state**,
  inside one transaction, so a restart mid-poll cannot invent a transition that did
  not happen, and two pollers cannot both observe the same one.
- A **delay is also inferred from a published start time moving later** by more than a
  configured threshold while the match is still upcoming. This is the provider
  republishing the match, not the clock passing — a start time merely being in the
  past is never evidence of anything (§6.4).
- Each `(match, transition)` pair is delivered at most once. A match that is delayed
  twice produces one delayed alert; if it then resumes and is delayed again, the
  second delay is a `LIVE → DELAYED` transition and does alert.

### 6.4 What must never trigger an alert

- A match **disappearing** from the provider's response. Absence is "not observed",
  never "cancelled".
- A scheduled start time **passing** with no change from the provider.
- An **unrecognised provider status**. Unknown maps to `UNKNOWN` and emits nothing in
  either direction.

---

## 7. Time handling

- **Canonical storage is UTC.** Every timestamp column is `timestamptz` and every
  in-memory canonical time is an absolute instant.
- **Display is always `APP_TIMEZONE` (Europe/London).**
- **GMT/BST is handled automatically** via the IANA `Europe/London` zone and a
  DST-correct date library. 
- **Never hard-code a `+0`/`+1` offset**, anywhere, including in tests. Tests assert
  DST correctness by covering dates on both sides of the March and October
  transitions.
- "Today", "this week", "this month" are always **Europe/London calendar** windows,
  converted to UTC instants before querying.
- Source times that arrive as venue-local wall-clock are converted to UTC using the
  venue offset **supplied by the source data**, never a guessed one.

## 8. Unknown start times

Tennis TV publishes tournament schedules before individual match times exist.

- **Never guess a start time.** Do not infer one from the previous day, the court
  order, or a tournament default.
- A match with no published start time is displayed as **`Time TBC`**.
- When Tennis TV later publishes a time, the match updates normally through the usual
  refresh path — no special case, no re-post of an already-sent summary.
- A `Time TBC` match still counts as "a match today" for §4.1's post/don't-post
  decision.
- Ordering within a summary: matches with known times sort by time; `Time TBC`
  matches sort after them, grouped by tournament.

### 8.1 Schedule granularity (tournament data vs match data)

Tennis TV publishes **tournaments** months in advance and **matches** only once the
draw or order of play exists. Verified 2026-09-14: tournaments starting in 9, 16, 62
and 109 days all returned **zero match records** — not matches with unknown times, no
matches at all. See `docs/TENNISTV_DATA_SOURCE.md` §7.

The bot models this distinction explicitly rather than pretending match data exists:

| Summary | Level it can realistically report |
| --- | --- |
| **Monthly** | Tournament level — name, location, date range. Match times will essentially never be available a month ahead. |
| **Weekly** | Tournament level, plus match detail for events already under way. |
| **Daily** | Match level, for tournaments in progress or starting that day. |

Rules:

- A summary states what it knows at the level it knows it. It never renders an empty
  match list as "no tennis" when the tournament data says otherwise.
- `metadata.matchesSize` is Tennis TV's *forecast* of an event's size. It is never
  read as a count of published matches.
- §4.1's post/don't-post decision for the daily summary is about **matches**. Whether
  a day with a tournament in progress but no published order of play should also post
  is an open product question recorded in `docs/ARCHITECTURE.md` §14.

## 9. Tennis TV availability

Tennis TV explicitly marks some tournaments as not being shown on its platform (the
Grand Slams and the Laver Cup, at the time of writing).

- Tournaments or matches **explicitly marked by Tennis TV as not shown must not be
  counted** — not in summaries, not in the "are there matches today" decision, and
  not as a source of live-state notifications.
- The rule is **exclude what is explicitly marked unavailable**, not "include only
  what is explicitly marked available". Absence of a marker means available.
- Filtering happens once, in the domain layer, against a normalised
  `isShownOnTennisTv` flag produced by the provider. No other module re-implements it.

## 10. Duplication

The bot must never send a duplicate:

- live alert
- delayed alert
- cancellation alert
- daily summary
- weekly summary
- monthly summary

**Restarts must not cause duplicate messages.** Crash, redeploy, and concurrent
instances are all covered: duplicate suppression is enforced in Postgres by a unique
constraint on a deterministic idempotency key, not by in-process memory.

Where a choice must be made, the bot prefers **missing a message over sending a
duplicate**. Startup reconciliation (see ARCHITECTURE.md) narrows that window.

## 11. Reliability

A temporary Tennis TV failure, network failure, Slack failure, or application restart
**must not corrupt match state or subscriptions**.

- Provider failures are retried with backoff and **never** interpreted as "the match
  disappeared" or "the match was cancelled".
- A poll that returns a partial or empty result set does not delete or reset stored
  match state.
- Slack failures leave the idempotency record in a resolvable state; the message is
  either retried or abandoned, never silently duplicated.
- Subscriptions are written in their own transaction and are unaffected by anything
  in the schedule/monitoring path.
- All persistent state changes are transactional. Read-modify-write on match state
  happens inside a transaction.

## 12. Simulation & test mode

Every important behaviour must be testable without waiting for Tennis TV to contain a
convenient live match.

### 12.1 Principles

1. **Simulations use the production path.** A simulation runs through the real state
   machine, the real transition detection, the real subscription lookup, the real Block
   Kit builders and the real publisher. A drill that avoids production code proves
   nothing. The only difference is a 🧪 TEST banner, applied inside the publisher so it
   can never be forgotten at a call site. With nobody opted in, a simulated alert posts
   nothing — exactly as production does — which is what makes "did my opt-in work?" a
   question a drill can answer.
2. **Simulations never contaminate production state.** A simulated run writes no match
   state at all, so a fabricated match can never become the "previous state" a real run
   compares against. Its messages are keyed `sim:<what>:<timestamp>`, so a drill can
   neither consume a real report key nor be suppressed as a duplicate of an earlier
   drill.

### 12.2 How a simulation is triggered

From the **Actions** tab on GitHub: the "Tennis simulation (manual test)" workflow, with
a dropdown for what to simulate and a tick-box for dry run. Nothing to install, no code
to edit, no command to remember.

| Choice | Does |
| --- | --- |
| `live` \| `delayed` \| `cancelled` | Posts that alert for a clearly fictional match, mentioning the people actually opted in |
| `daily` \| `weekly` \| `monthly` | Posts that report, built from **real Tennis TV data**, marked as a test |

A slash command was the original design and was dropped: answering one needs a process
already running to reply inside Slack's three-second budget, and no such process exists
any more. The `workflow_dispatch` is both simpler to operate and simpler to secure —
GitHub already knows who is allowed to run it.

Equivalent locally: `npm run bot:simulate -- live`.

### 12.3 Access

Whoever can run workflows on the repository. That is GitHub's own permission model, so
there is no separate admin list to keep in step and no way to be locked out of your own
bot by a misconfigured variable.

A simulated alert is the only thing a drill puts in the channel, and it always carries
the test banner.

### 12.4 Provider modes

`TENNISTV_PROVIDER` selects where schedule data comes from:

| Mode | Behaviour |
| --- | --- |
| `live` | Real Tennis TV data. |
| `fixture` | Recorded payloads from `test/fixtures/tennistv/`. Deterministic, offline. |

The simulation system is independent of this: it works in any mode, because it creates
its own records rather than asking the provider for them.

`SLACK_DRY_RUN=true` logs outbound Slack calls instead of sending them, for local runs
against a real workspace without posting.

## 13. Configuration

Nothing environment-specific is hard-coded. Configuration is read once at the start of a
run, validated with a runtime schema, and a validation failure is fatal with every
problem listed at once. Error messages name variables, never values, so a rejected token
cannot be echoed into a build log.

An unset optional variable and a variable set to an empty string are treated the same
way, because GitHub Actions renders an unset repository variable as an empty string.

### 13.1 The GitHub Actions runner

**Secrets** — masked in logs, never printed:

| Variable | Purpose |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`), to post messages. |
| `INTERNAL_API_SECRET` | Bearer token for the Worker's state API. Identical to the Worker's own secret. |

**Variables** — not secret, visible in the run log:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SLACK_CHANNEL_ID` | *required* | The one channel for summaries **and** live alerts. |
| `STATE_API_URL` | *required* | Base URL of the deployed Worker. |
| `APP_TIMEZONE` | `Europe/London` | IANA zone. Never a fixed offset. |
| `SUMMARY_HOUR` | `8` | Local hour the reports belong to. |
| `TENNISTV_BASE_URL` | `https://www.tennistv.com` | Public site, for deep links. |
| `TENNISTV_API_BASE_URL` | `https://api.tennistv.com` | Tennis TV JSON API host. |
| `TENNISTV_ACCOUNT_ID` | `35` | Sent as the `account-id` header. |
| `TENNISTV_PROVIDER` | `live` | `live` \| `fixture`. |
| `MONITOR_SCHEDULE_SLIP_MINUTES` | `15` | How much later a republished start counts as a delay. |
| `STATE_RETENTION_DAYS` | `30` | How long settled state is kept. |
| `RUN_TIMEOUT_SECONDS` | `240` | Whole-run ceiling, enforced by the command. |
| `LOG_LEVEL` | `info` | Structured-log level. |
| `SLACK_DRY_RUN` | `false` | Log Slack sends instead of performing them. |

### 13.2 The Cloudflare Worker

**Secrets** — `wrangler secret put`:

| Variable | Purpose |
| --- | --- |
| `SLACK_SIGNING_SECRET` | Verifies that a button click genuinely came from Slack. |
| `INTERNAL_API_SECRET` | The same value as the GitHub secret above. Unset disables the state API entirely. |

**Variables** — `vars` in `wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SLACK_CHANNEL_ID` | *required* | Fallback channel for a click that arrives without one. |
| `LOG_LEVEL` | `info` | |

There is **no `SLACK_APP_TOKEN`** (Socket Mode is not used), **no `DATABASE_URL`**
(state lives in D1), and **no Tennis TV credential** (the API is public; `account-id` is
a header, not a secret).

## 14. Technical constraints

- Current Node.js LTS (24.x), TypeScript, ES modules.
- Slack **Web API** for outgoing messages. Button clicks arrive over HTTPS at the
  Cloudflare Worker, which verifies Slack's request signature. **No Socket Mode**, and
  no incoming webhooks as the primary architecture.
- **Cloudflare D1** for the small amount of state that must persist, reached over HTTPS
  through the Worker. No PostgreSQL anywhere, in production or in development.
- Runtime validation with Zod at every trust boundary.
- Structured logging (pino).
- Vitest for tests. Playwright **only** where a browser is genuinely required.
- TypeScript errors are never suppressed or silently ignored.
- No `TODO`/stub implementations left in production paths.

## 15. Architectural constraints

- **Tennis TV must sit behind a `TennisTvProvider` interface.**
- Slack, scheduling and business logic must **never** contain page selectors, HTML
  knowledge, API URLs, or Tennis TV field names.
- If Tennis TV redesigns its website or API, only the provider implementation should
  need repair.
- Prefer simple, boring, maintainable architecture. One process, one database.
- No microservices. No Redis unless a proven need appears. No unnecessary
  abstractions. No huge files. A sensible dependency count.

## 16. Non-goals (v1)

- No DMs of any kind.
- No per-tournament, per-player or per-court subscription filters.
- No scores, results, or match commentary.
- No web UI or dashboard.
- No WTA/non-Tennis-TV coverage.
- No multi-channel or multi-workspace support.
- No re-posting a summary when the schedule changes after it was sent.

## 17. Acceptance criteria

Each is verifiable via the simulation mode described in §12.

1. Daily with matches → exactly one summary posted; daily with no matches → nothing posted.
2. Weekly and monthly always post, empty or not, with dates and UK-local times.
3. Running the same scheduled occurrence twice (including across a restart) posts once.
4. Opt in ×3 then opt out ×3 leaves the user opted out, with an ephemeral confirmation each time and no errors.
5. A match going live posts to the channel, mentioning exactly the current opt-ins.
6. With zero subscribers, going live posts nothing — and the transition is not replayed when someone subscribes afterwards.
7. Delayed and cancelled transitions each post at most once per match.
8. No message ever contains `@channel`, `@here` or `@everyone` (asserted by an automated test over every rendered message).
9. A match with no published start renders as `Time TBC`, and renders as a real time once published.
10. Tournaments marked not shown on Tennis TV never appear and never trigger alerts.
11. A summary spanning the October DST change shows correct UK times either side.
12. Killing the process mid-send and restarting produces no duplicate.
13. Provider returning 500s, timeouts, or an empty payload leaves stored state and subscriptions intact.

## 18. Open questions

Tracked in `docs/ARCHITECTURE.md` § Reconnaissance backlog. These are known unknowns
about Tennis TV's data, not about our design, and none of them block the phased build.
