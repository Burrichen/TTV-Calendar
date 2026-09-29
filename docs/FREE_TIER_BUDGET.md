# Free-tier budget

What this bot actually costs to run, measured rather than estimated where that was
possible, and stated as an estimate where it was not.

**Short answer:** it fits, but on a **private** repository the GitHub Actions allowance
is the only tight constraint — about **78% consumed**, leaving ~450 minutes a month for
everything else including CI. Cloudflare and D1 are not close to any limit. Making the
repository **public** removes the constraint entirely, because public repositories get
unlimited standard-runner minutes.

---

## 1. How often things run

| Job | Schedule | Runs per 30-day month | Runs per 31-day month |
| --- | --- | --- | --- |
| Monitor | `7,37 * * * *` — every 30 min | 1,440 | 1,488 |
| Morning reports | `0 7 * * *` **and** `0 8 * * *` | 60 | 62 |
| **Total scheduled jobs** | | **1,500** | **1,550** |

> **The morning job runs twice a day, not once.** GitHub cron has no timezone support,
> so the workflow fires at both 07:00 and 08:00 UTC and the application decides which
> one is 08:00 in `Europe/London` (ARCHITECTURE.md §15.1). Exactly one of them posts;
> the other exits in about a second having done one database read. Both are billed.
>
> If you had budgeted for 31 morning runs, the real figure is 62. See §7 for the option
> that removes them.

CI runs on pushes and pull requests, and comes out of the same allowance. The simulation
workflow only runs when you press the button.

---

## 2. Measured runtime

Measured on a development machine, Node 24.11, against the **real** Tennis TV API.

| Phase | Measured | Notes |
| --- | --- | --- |
| `npm ci --omit=dev` | **0.8 s** | 48 packages, 30 MB, warm npm cache |
| Node boot + TypeScript stripping | **0.06 s** | Types are stripped at load; there is no build step |
| Application module load | **0.08 s** | |
| Tennis TV — first request of a process | **0.8 s** | Cold DNS + TLS + origin |
| Tennis TV — subsequent requests | **0.08 s** | Warm connection and CDN |
| Whole monitor command, cold | **0.6 – 0.9 s** | 2 tournaments, 54 matches |

**The cold number is the one that matters.** Every GitHub run is a fresh machine with
cold DNS and a cold TLS session, so 0.8 s is representative and 0.08 s is not.

### What the runner adds

These could not be measured here and are **estimates**, with their basis stated. §6
explains how to replace them with your own real numbers after the first day.

| Step | Estimate | Basis |
| --- | --- | --- |
| `actions/checkout` (`fetch-depth: 1`) | 2 – 4 s | Small shallow repository |
| `actions/setup-node` (`cache: npm`) | 3 – 8 s | Cache restore plus Node setup |
| `npm ci --omit=dev` | 2 – 5 s | Measured 0.8 s locally; slower on a cold runner |
| The command itself | 1 – 2 s | Measured above |
| **Total job execution** | **≈ 10 – 20 s** | |

Queue time is not billed; only job execution is.

---

## 3. What a job actually costs

**GitHub rounds every job up to the whole minute.** A job that takes 12 seconds is
billed as one minute. This is the single most important fact in this document: shaving
seconds off a 15-second job saves nothing at all, while letting a job creep past 60
seconds **doubles** the bill.

So the budget is simply the number of jobs:

| | 30-day month | 31-day month |
| --- | --- | --- |
| Monitor | 1,440 min | 1,488 min |
| Morning | 60 min | 62 min |
| **Scheduled total** | **1,500 min** | **1,550 min** |
| GitHub Free (private) allowance | 2,000 min | 2,000 min |
| **Consumed** | **75%** | **78%** |
| Remaining for CI, simulations, re-runs | 500 min | 450 min |

Linux runners bill at 1× (Windows is 2×, macOS 10×), which is why everything uses
`ubuntu-latest`.

**Public repositories get unlimited standard-runner minutes.** If this repository can be
public, none of the above is a constraint. Nothing secret lives in the repository —
tokens are GitHub Secrets and Cloudflare Worker secrets — so publishing it is a real
option.

### The margin, honestly

450 minutes of headroom is roughly 450 CI runs, which is generous for a project of this
size. But it is not unlimited, and two things eat it:

- **a busy development month** — every push and pull request runs CI;
- **a job that starts exceeding 60 seconds**, which would take the scheduled total from
  1,550 to 3,100 and put you over. Both production workflows have `timeout-minutes` set
  (5 and 10) as a backstop, and the application has its own `RUN_TIMEOUT_SECONDS`
  (default 240 s) that fires first with a diagnostic.

If you approach the limit, GitHub simply stops running workflows until the next billing
month. It does not charge you. **Do not enable spending limits.**

---

## 4. Cloudflare Workers

Measured call counts per run:

| Scenario | Calls to the Worker |
| --- | --- |
| Monitor — nothing on today | **0** |
| Monitor — matches on, nothing changed (typical) | **2** (load state, save state) |
| Monitor — one match changes state | **5** (+ subscribers, claim, settle) |
| Morning — reports already sent (typical) | **1** (status check) |
| Morning — sends one report | **3** (status, claim, settle) |

A month at the typical rate:

```
monitor   1,488 runs × 2 calls   ≈ 2,976
morning      62 runs × ~2 calls  ≈    124
alerts    say 100 transitions    ≈    300
buttons   a handful               ≈     50
                                  ───────
                                  ≈ 3,450 requests/month
```

| | Usage | Free tier | Consumed |
| --- | --- | --- | --- |
| Worker requests | ~3,450 / month | 100,000 / **day** | **~0.1% of a single day's allowance** |

Not close. The Worker also does no work at all between requests — there is no Cron
Trigger — so it costs nothing while idle.

---

## 5. Cloudflare D1

Row counts per monitor run are driven by how many matches are on. A busy day with three
tournaments running is roughly 100 match rows.

| | Per day | Free tier | Consumed |
| --- | --- | --- | --- |
| Rows read | 48 runs × ~100 = **~4,800** | 5,000,000 / day | **~0.1%** |
| Rows written | 48 runs × ~100 = **~4,800** | 100,000 / day | **~5%** |
| Storage | 3 tables, pruned at 30 days | 5 GB | negligible |

Writes are the closest to a limit, at about 5% of the daily allowance, and that is a
*busy* day. A quiet day with no tournaments writes nothing at all, because the monitor
makes no state call when nothing is on.

Storage stays small because the retention sweep deletes match state and settled
notifications older than `STATE_RETENTION_DAYS` (default 30). Subscriptions are never
pruned — they are the one thing that cannot be recomputed.

> **Note:** nothing currently calls the prune endpoint on a schedule. Until something
> does, D1 will grow slowly — a few thousand rows a month, which is still far inside the
> 5 GB limit, but it should be wired up. See §7.

---

## 6. Checking your real usage

Replace this document's estimates with your own numbers as they arrive.

### After 24 hours

**GitHub** → repository → **Actions** tab. Open any completed monitor run and read the
duration next to the job name. That is the real execution time; if it is comfortably
under a minute, the projection in §3 holds.

For the account-wide figure: your avatar → **Settings** → **Billing and plans** →
**Plans and usage** → **Actions minutes**.

**Cloudflare** → **Workers & Pages** → `ttv-calendar-bot` → **Metrics**. Requests,
errors and CPU time for the last 24 hours.

**D1** → **Storage & Databases** → **D1** → `ttv-calendar` → **Metrics**. Rows read and
written.

### After 7 days

Multiply the 7-day Actions figure by 4.3 for a monthly projection. You should see
roughly 350 minutes a week. If it is materially higher, check whether a job is exceeding
60 seconds or whether CI is running more often than expected.

`npm run worker:tail` streams the Worker's live logs if you want to watch a button click
or a state call as it happens.

### After 1 month

Compare the billing page against the 2,000-minute allowance. GitHub's usage page also
breaks the total down per workflow, which will show directly how much CI is taking
versus the scheduled jobs.

---

## 7. If it gets tight

In rough order of how much they save for how much disruption:

1. **Make the repository public.** Removes the Actions constraint entirely. Nothing
   secret is in the repository.
2. **Merge the morning workflow into the monitor.** The monitor already runs every 30
   minutes; having it also check whether a report is due would remove 62 jobs a month
   and improve catch-up, at the cost of a slightly longer run once a day. This is a
   workflow change, not an architecture change — the trade is one fewer workflow to
   reason about against a slightly busier monitor.
3. **Lengthen the monitor interval.** Going from 30 to 60 minutes halves the largest
   line to 744 minutes. It also doubles the worst-case delay before an alert, so this
   is a product decision, not a technical one.
4. **Wire up retention.** Not a minutes saving, but it keeps D1 flat rather than slowly
   growing.

What *not* to do: bundling the application to shave install time, or caching
`node_modules` beyond what `actions/setup-node` already does. Neither changes the
billed figure, because every job already rounds up to the same one minute. Measurement
does not justify the complexity.

---

## 8. Scheduling honesty

The monitor is scheduled at `:07` and `:37` — exactly 30 minutes apart, around the
clock, with no deliberate overnight gap.

**GitHub does not guarantee that a scheduled workflow starts on time.** Its scheduler is
shared and best-effort: runs are frequently delayed by several minutes under load, and
during a platform incident a run can be skipped entirely. The `:07`/`:37` minutes were
chosen because on-the-hour and on-the-half-hour are the most congested, but that reduces
the delay rather than removing it.

So the honest statement is: **checks are scheduled 30 minutes apart, and a notification
normally arrives within roughly 30–40 minutes of a match changing state.** This is not a
real-time system and should not be described as one. Nothing breaks when a run is late
or skipped — the next run picks up whatever the last one missed, because state lives in
D1 rather than in the run.
