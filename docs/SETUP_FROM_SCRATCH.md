# Setting this up from scratch

A complete, in-order guide to getting the bot running. It assumes you have **never**
used Cloudflare, D1, Wrangler, GitHub Actions or Slack app configuration before, and
explains what each command does and what success looks like.

Budget about **45 minutes** the first time.

Everything here is free. You will not be asked for a card, and nothing in this guide
enables paid usage.

---

## What you are building

```
GitHub Actions                          Cloudflare Worker
  every 30 min: check for live matches     receives Slack button clicks
  every morning: post the schedule         holds a small database (D1)
        │                                          ▲
        └──────── asks it what it already ─────────┘
                  knows, over HTTPS
```

Three accounts are involved: **Slack** (where messages appear), **Cloudflare** (which
receives button clicks and stores who opted in), and **GitHub** (which runs the bot on a
schedule). Nothing runs on your computer.

## Before you start

You need:

- the repository cloned locally, and **Node 24** (`nvm use` reads `.nvmrc`)
- permission to install a Slack app in your workspace — if you are not a workspace
  admin, you can still create it, but an admin has to approve the install
- a GitHub account, and the repository pushed to it

Install the project's dependencies once:

```sh
npm install
```

---

# Part 1 — Cloudflare

Cloudflare gives us two things: a public HTTPS address for Slack to send button clicks
to, and a small database. Both are free at the volumes this bot uses.

## 1.1 Create a Cloudflare account

Go to <https://dash.cloudflare.com/sign-up>, sign up with an email address, and verify
it. You do **not** need a domain name, and you do **not** need to add a payment method.
Choose the **Free** plan if asked.

## 1.2 Log Wrangler in

Wrangler is Cloudflare's command-line tool. It is already a dependency of this project,
so there is nothing to install — `npx` runs the version pinned in `package.json`.

```sh
npx wrangler login
```

A browser window opens asking you to authorise Wrangler. Click **Allow**.

**Success looks like:** the terminal prints something like

```
Successfully logged in.
```

Check it worked:

```sh
npx wrangler whoami
```

This prints the email address and account ID you just logged in as.

## 1.3 Create the D1 database

D1 is Cloudflare's small SQL database. Create one called `ttv-calendar`:

```sh
npx wrangler d1 create ttv-calendar
```

**Success looks like** a block of configuration printed to the terminal, containing a
line like:

```
database_id = "a1b2c3d4-0000-0000-0000-abcdefabcdef"
```

**Copy that `database_id`.** You need it in the next step. It is an identifier, not a
password — it is safe to put in the repository.

## 1.4 Connect the database to the Worker

Open [`wrangler.jsonc`](../wrangler.jsonc) and find this line:

```jsonc
"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID",
```

Replace the placeholder with the ID you just copied. Save the file.

## 1.5 Create the tables

The database exists but is empty. This creates the three tables:

```sh
npm run d1:migrate:remote
```

Wrangler asks you to confirm, because it is changing the real database. Type `y`.

**Success looks like:**

```
🚣 3 commands executed successfully.
```

To do the same against a local copy for experimenting, use `npm run d1:migrate:local`.

## 1.6 Generate the shared secret

The GitHub runner proves who it is to the Worker with a shared secret. Generate a strong
one:

```sh
openssl rand -hex 32
```

That prints 64 random characters. **Copy it somewhere safe for the next few minutes** —
you will paste the same value into two places, and Cloudflare will not show it to you
again afterwards.

> Do not put it in any file in this repository.

## 1.7 Add the Worker's secrets

Cloudflare stores secrets separately from the code. Add the shared secret:

```sh
npx wrangler secret put INTERNAL_API_SECRET
```

It prompts for the value: paste the 64 characters from the previous step and press
Enter. **Success looks like** `✨ Success! Uploaded secret INTERNAL_API_SECRET`.

Now the Slack signing secret. You do not have it yet — it comes from Part 2 — so
**come back and run this after step 2.4**:

```sh
npx wrangler secret put SLACK_SIGNING_SECRET
```

## 1.8 Set the channel ID

You do not have this yet either; it comes from step 2.6. When you do, open
`wrangler.jsonc` and replace:

```jsonc
"SLACK_CHANNEL_ID": "REPLACE_WITH_YOUR_SLACK_CHANNEL_ID",
```

Unlike the secrets, this one lives in the file — a channel ID is not sensitive.

## 1.9 Deploy the Worker

Once both secrets are set and the channel ID is filled in:

```sh
npm run worker:deploy
```

**Success looks like:**

```
Total Upload: 792.09 KiB / gzip: 126.11 KiB
Uploaded ttv-calendar-bot (2.51 sec)
Deployed ttv-calendar-bot triggers (0.60 sec)
  https://ttv-calendar-bot.<your-subdomain>.workers.dev
Current Version ID: ...
```

**Copy that `https://...workers.dev` URL.** It is your Worker's address, and you need it
twice: once for Slack, once for GitHub.

If the output mentions **Cron Triggers**, something is wrong — this Worker deliberately
has none.

## 1.10 Check the Worker is alive

```sh
curl https://ttv-calendar-bot.<your-subdomain>.workers.dev/health
```

**Success looks like:**

```json
{"status":"ok","service":"ttv-calendar-worker"}
```

## 1.11 Watching the logs

To see what the Worker is doing, live:

```sh
npm run worker:tail
```

Leave it running in a second terminal while you test. It prints one JSON line per event.
Press `Ctrl+C` to stop. Nothing is charged for this.

You can also see logs in the dashboard: **Workers & Pages** → `ttv-calendar-bot` →
**Logs**.

## 1.12 Looking inside the database

To see who has opted in:

```sh
npx wrangler d1 execute ttv-calendar --remote \
  --command "SELECT team_id, channel_id, user_id, enabled FROM subscriptions"
```

Straight after setup this returns no rows — nobody has clicked the button yet.

The other two tables are `match_state` (what the bot last saw for each match) and
`notifications` (what it has already sent).

---

# Part 2 — Slack

## 2.1 Create the app

1. Go to <https://api.slack.com/apps> and click **Create New App**.
2. Choose **From an app manifest**.
3. Pick your workspace.
4. Choose the **YAML** tab, delete what is there, and paste the entire contents of
   [`slack-app-manifest.yaml`](../slack-app-manifest.yaml).
5. Click **Next**, then **Create**.

Slack shows a summary of what the app will be able to do. It asks for two permissions:

| Scope | Why |
| --- | --- |
| `chat:write` | To post the schedules and alerts |
| `channels:history` | To check whether a message it already sent actually arrived, so a retry cannot post it twice |

> If your channel is **private**, change `channels:history` to `groups:history` in the
> manifest before creating the app.

## 2.2 Set the Request URL

The manifest contains a placeholder address for button clicks. Replace it now:

1. In the app's left sidebar, click **Interactivity & Shortcuts**.
2. Make sure the toggle is **On**.
3. In **Request URL**, enter your Worker address with `/slack/interactions` on the end:

   ```
   https://ttv-calendar-bot.<your-subdomain>.workers.dev/slack/interactions
   ```

4. Click **Save Changes**.

Slack immediately sends a signed test request. If it says the URL did not respond,
either the Worker is not deployed yet or `SLACK_SIGNING_SECRET` is not set — both are
fixed in Part 1.

> **You do not need Socket Mode, and you do not need a `SLACK_APP_TOKEN`
> (`xapp-…`).** Earlier versions of this bot used them; this one does not. If you see a
> guide telling you to generate an app-level token, it does not apply here. Leave
> **Socket Mode** switched off.

## 2.3 Install the app

1. Click **Install App** in the sidebar.
2. Click **Install to Workspace**, then **Allow**.

## 2.4 Copy the two credentials

**Bot token:** **OAuth & Permissions** → **Bot User OAuth Token**. It starts `xoxb-`.
Copy it — you will paste it into GitHub in Part 3.

**Signing secret:** **Basic Information** → **App Credentials** → **Signing Secret** →
**Show**. Copy it.

Now go back and finish step 1.7:

```sh
npx wrangler secret put SLACK_SIGNING_SECRET
```

Paste the signing secret when prompted.

> Treat both of these like passwords. Never paste them into a file in this repository,
> a commit message, or a chat window.

## 2.5 Invite the bot to the channel

Decide which Slack channel the bot will post in, then in that channel type:

```
/invite @Tennis TV Calendar
```

A bot with `chat:write` can only post in channels it has been invited to, so skipping
this makes every post fail with `not_in_channel`.

## 2.6 Get the channel ID

Click the channel name at the top of Slack → scroll to the bottom of the **About** tab →
the **Channel ID** is there, starting with `C`. Copy it.

Now finish step 1.8 (put it in `wrangler.jsonc`) and redeploy:

```sh
npm run worker:deploy
```

---

# Part 3 — GitHub

## 3.1 Where the settings live

In your repository on GitHub:

**Settings** → in the left sidebar, **Secrets and variables** → **Actions**

That page has two tabs: **Secrets** and **Variables**. Secrets are hidden once saved and
masked in logs. Variables are visible to anyone who can read the repository.

## 3.2 Add the secrets

**Secrets** tab → **New repository secret**, twice:

| Name | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | The `xoxb-…` token from step 2.4 |
| `INTERNAL_API_SECRET` | **The exact same 64 characters** you gave Cloudflare in step 1.7 |

> `INTERNAL_API_SECRET` **must be byte-for-byte identical** in both places. It is how
> the GitHub runner proves to the Worker that it is allowed to read and write the
> database. If they differ, every run fails with `401` and nothing is posted.
>
> If you lose it, generate a new one with `openssl rand -hex 32` and update **both**
> sides. Nothing else is affected.

## 3.3 Add the variables

**Variables** tab → **New repository variable**. Only the first two are required:

| Name | Value | Required |
| --- | --- | --- |
| `SLACK_CHANNEL_ID` | The `C…` ID from step 2.6 | **yes** |
| `STATE_API_URL` | `https://ttv-calendar-bot.<your-subdomain>.workers.dev` — no trailing slash | **yes** |
| `APP_TIMEZONE` | `Europe/London` | no — this is the default |
| `SUMMARY_HOUR` | `8` | no — this is the default |
| `LOG_LEVEL` | `info` | no — this is the default |
| `TENNISTV_BASE_URL` | `https://www.tennistv.com` | no — this is the default |

Leave the optional ones unset unless you want to change them. The application treats an
unset variable and a blank one identically.

## 3.4 Enable Actions

Click the **Actions** tab. If this is a fresh fork or a new repository, GitHub asks you
to confirm before running workflows — click **I understand my workflows, go ahead and
enable them**.

You should then see four workflows listed on the left:

| Workflow | What it does |
| --- | --- |
| **Tennis monitor** | Every 30 minutes, checks for live/delayed/cancelled matches |
| **Tennis morning reports** | Each morning, posts the daily, weekly and monthly schedules |
| **Tennis simulation (manual test)** | Posts a test message when you ask it to |
| **CI** | Runs the tests when you push code |

> **Scheduled workflows do not start until the repository has activity on its default
> branch.** If nothing has run after a couple of hours, push a commit.
>
> GitHub also disables scheduled workflows automatically in a repository with **60 days
> of no activity**, and emails you first. A single commit re-enables them.

## 3.5 Running a workflow by hand

Click the workflow name → **Run workflow** (top right) → choose the branch → **Run
workflow**. For the simulation workflow you also get a dropdown for what to simulate.

To see what happened, click the run, then the job name. Each step expands to show its
output.

## 3.6 Re-running a failed workflow

Open the failed run → **Re-run jobs** (top right) → **Re-run failed jobs**.

This is always safe. Every message the bot sends is claimed in the database before it is
sent, so a re-run of a job that already posted will find the work done and post nothing.

## 3.7 Checking Actions usage

Your avatar (top right) → **Settings** → **Billing and plans** → **Plans and usage** →
**Actions minutes**.

See [`FREE_TIER_BUDGET.md`](FREE_TIER_BUDGET.md) for what to expect and what to do if it
climbs.

---

# Part 4 — Your first production test

Do these in order. Each one checks something the next one depends on, so if a step
misbehaves, stop and fix it before continuing.

### 1. The Worker is alive

```sh
curl https://ttv-calendar-bot.<your-subdomain>.workers.dev/health
```

Expect `{"status":"ok","service":"ttv-calendar-worker"}`.

### 2. Post something with buttons

In the Slack channel, run the **Tennis simulation** workflow with **weekly**. This posts
this week's schedule, marked 🧪 TEST, with the two subscription buttons underneath.

> If the week has no tennis, you still get a message saying so. That is correct
> behaviour — the weekly report always posts.

### 3. Click **🔔 Opt in to live alerts**

You should see a private confirmation, visible only to you:

> ✅ You're opted in to Tennis TV live alerts.
> You'll be @mentioned here when a match starts, is delayed or is cancelled.

If nothing happens, or you see "couldn't update", check `npm run worker:tail`.

### 4. Confirm the subscription was stored

```sh
npx wrangler d1 execute ttv-calendar --remote \
  --command "SELECT user_id, enabled FROM subscriptions"
```

Expect one row, with `enabled` as `1`.

### 5. Run **TEST LIVE**

Actions → **Tennis simulation (manual test)** → **Run workflow** → choose `live`.

In Slack you should see:

```
🧪 TEST — simulated message, not a real Tennis TV event.
🔴 LIVE — Test Player A vs Test Player B
Simulation Open (test data)
Started 14:03 UK

@you
```

Check three things: the **🧪 TEST** banner is there, **you are @mentioned**, and it went
to the channel rather than a DM.

### 6. Click **🔕 Opt out of live alerts**

Expect: *🔕 You've opted out of Tennis TV live alerts.*

### 7. Run **TEST LIVE** again

**Nothing should be posted.** The run succeeds, and its log says:

> Nobody is opted in, so no alert was posted — which is the correct production
> behaviour.

That is the rule that stops the bot talking to an empty room, demonstrated.

### 8. Opt back in

Click **🔔 Opt in** again, so you actually receive alerts.

### 9. Run the three report simulations

Run the simulation workflow three more times: `daily`, `weekly`, `monthly`. Check the
times read sensibly in UK time, and that anything Tennis TV has not scheduled yet shows
as **TBC** rather than a guess.

> `daily` posts nothing if there is no tennis today. That is correct — the daily report
> is the only one that stays silent when empty.

### 10. Run the real monitor

Actions → **Tennis monitor** → **Run workflow**.

This is safe to run by hand: it checks real matches and posts only if something has
genuinely changed state since the last run. Most of the time it posts nothing at all.

Open the run's log and you should see lines like:

```
monitor started
Tennis TV read ok        {"tournaments":2,"runningToday":2}
live state read ok       {"matches":54}
monitor completed        {"durationMs":812,"matchesChecked":54,"transitions":0,"alertsSent":0}
```

`transitions: 0` means nothing changed, which is the normal result.

### 11. Wait for a scheduled run

Within half an hour, **Tennis monitor** should appear in the Actions list having run on
its own. Once that happens, setup is complete.

---

# Part 5 — Turning it off and on

## Stop everything, without deleting anything

**Actions** tab → click **Tennis monitor** → the **⋯** menu (top right) → **Disable
workflow**. Repeat for **Tennis morning reports**.

The workflows stop immediately. Nothing is deleted, no configuration is lost, and the
Worker keeps answering button clicks.

**To start again:** same menu → **Enable workflow**. The next scheduled run picks up
normally. Reports missed while disabled are not back-filled beyond their grace window —
a missed daily report is gone, but the current week's and month's will still send.

## Stop the buttons too

In the Slack app settings → **Interactivity & Shortcuts** → toggle **Off** → **Save
Changes**. Existing buttons stop doing anything; nobody's subscription is lost.

Alternatively `npx wrangler delete` removes the Worker entirely — but that also makes
the state API unreachable, so the monitor would fail rather than run quietly. Prefer
disabling the workflows.

## Stop it posting, but keep it running

Set the repository variable `SLACK_DRY_RUN` to `true`. Everything runs and logs what it
*would* have said, and sends nothing.

---

# Part 6 — Making changes later

## Changing the bot's behaviour (most changes)

```sh
# 1. make your change, then check it
npm run verify          # typecheck, lint, and the full test suite

# 2. commit and push
git add -A
git commit -m "Describe the change"
git push
```

Open a pull request; CI runs automatically. Once it is merged into `main`, **the next
scheduled run uses the new code** — the workflows check out `main` each time. There is
nothing to deploy and no restart.

## Changing the Worker (buttons, or the state API)

Worker code lives in [`worker/`](../worker/). After merging:

```sh
npm run worker:deploy
```

This one **is** a manual step: GitHub does not deploy the Worker for you. A deploy takes
a few seconds and does not interrupt anything.

## Changing the database shape

Add a new numbered file to [`migrations/`](../migrations/) — never edit an existing one,
because it has already been applied. Then:

```sh
npm run d1:migrate:remote
```

---

# Part 7 — Backing up D1

## What is actually in there

| Table | What it holds | If it were lost |
| --- | --- | --- |
| `subscriptions` | Who has opted in | **Cannot be rebuilt.** Everyone would have to click 🔔 again |
| `match_state` | What each match looked like at the last check | Rebuilds itself within one run. The only visible effect is that matches already live when the table was emptied will not alert |
| `notifications` | What has already been sent | Rebuilds itself. The risk is a small number of duplicate messages for anything sent in the preceding few hours |

So: **only the subscription list genuinely matters**, and it is small.

## Taking a backup

```sh
npx wrangler d1 export ttv-calendar --remote --output ttv-calendar-backup.sql
```

That writes a plain SQL file. Keep it somewhere outside this repository — it contains
your team's Slack user IDs.

A backup before any migration is a sensible habit. Day to day, backing up monthly is
proportionate for data that is this small and this recoverable.

## Restoring

```sh
npx wrangler d1 execute ttv-calendar --remote --file ttv-calendar-backup.sql
```

If you only need the subscriptions back, it is often quicker to ask people to click the
button again than to restore.

---

# Part 8 — Keeping it at £0

The full measured breakdown is in [`FREE_TIER_BUDGET.md`](FREE_TIER_BUDGET.md). The
short version:

| Service | Expected use | Free allowance | Headroom |
| --- | --- | --- | --- |
| GitHub Actions (**private** repo) | ~1,550 min/month | 2,000 min/month | ~450 min |
| GitHub Actions (**public** repo) | same | unlimited | unlimited |
| Cloudflare Workers | ~3,450 requests/month | 100,000 **per day** | enormous |
| Cloudflare D1 | ~4,800 writes/day | 100,000/day | ~95% |

**The only thing close to a limit is GitHub Actions on a private repository**, at about
78% of the monthly allowance. That remaining 450 minutes also covers CI on every push.

The reason is not runtime — a monitor run takes under a second of actual work — but that
**GitHub bills every job as a minimum of one whole minute**. 1,488 monitor runs a month
is therefore 1,488 minutes however fast each one is.

### If you are getting close

In order of preference:

1. **Make the repository public.** Public repositories get unlimited standard-runner
   minutes. Nothing secret lives in the repository — the tokens are all in GitHub
   Secrets and Cloudflare secrets — so this is usually the right answer.
2. **Reduce CI runs.** CI runs on every push and pull request. Pushing less often, or
   batching commits, costs nothing in quality.
3. **Check where it is actually going.** The billing page breaks usage down per
   workflow. If CI is the larger share, the monitor is not your problem.
4. **Review after a full month** before changing anything. The estimate above is a
   projection; your real number is on the billing page.

If you do hit the limit, GitHub simply stops running workflows until the next billing
month. **It does not charge you.** Do not set a spending limit to "fix" this — that is
what turns a free service into a paid one.

The 30-minute monitor interval is a product requirement and is not the thing to cut.

---

# Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Slack says the Request URL did not respond | Worker not deployed, or `SLACK_SIGNING_SECRET` not set | Redo 1.7 and 1.9 |
| Clicking a button does nothing | Signing secret mismatch | `npx wrangler secret put SLACK_SIGNING_SECRET` again, then `npm run worker:tail` and click |
| "Sorry — I couldn't update your alert preference" | D1 unreachable, or migrations not applied | `npm run d1:migrate:remote` |
| Workflow fails with `401` | `INTERNAL_API_SECRET` differs between GitHub and Cloudflare | Generate a new one and set it in **both** |
| Workflow fails with `not_in_channel` | Bot was never invited | `/invite @Tennis TV Calendar` in the channel |
| Workflow fails with `channel_not_found` | `SLACK_CHANNEL_ID` wrong | Re-copy it from the channel's About tab |
| "Invalid configuration" with a list of variables | A required secret or variable is missing | The message names each one; add them in 3.2 and 3.3 |
| Nothing has run on a schedule | Scheduled workflows need repository activity | Push a commit |
| Alerts arrive late | GitHub's scheduler is best-effort | Expected. See `FREE_TIER_BUDGET.md` §8 |
| A message arrived twice | Should not happen | Report it — the idempotency ledger is meant to prevent it |

Two commands answer most questions:

```sh
npm run worker:tail    # live Worker logs — button clicks, state API calls
```

and the **Actions** tab, where every scheduled run keeps its full log.
