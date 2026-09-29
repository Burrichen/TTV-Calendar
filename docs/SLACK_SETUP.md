# Slack setup

How to create the Slack app this bot needs, and why it asks for what it asks for.

**Manifest:** [`slack-app-manifest.yaml`](../slack-app-manifest.yaml)

---

## 1. Create the app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick the workspace, choose **YAML**, and paste the contents of
   `slack-app-manifest.yaml`.
3. Review and create.

## 2. Collect the token and the signing secret

Two values, and they do different jobs: one proves the bot to Slack, the other proves
Slack to the bot.

| Value | Where | Goes to | What it is |
| --- | --- | --- | --- |
| `xoxb-…` | **OAuth & Permissions** → Bot User OAuth Token (after installing) | GitHub Actions secret `SLACK_BOT_TOKEN` | Acts as the bot: posts messages. |
| Signing secret | **Basic Information** → App Credentials → Signing Secret | Cloudflare Worker secret `SLACK_SIGNING_SECRET` | Lets the Worker verify that a button click genuinely came from Slack. |

There is **no app-level token**. `SLACK_APP_TOKEN` was needed for Socket Mode, which
this bot no longer uses: button clicks arrive over HTTPS at the Cloudflare Worker
instead (ARCHITECTURE.md §17).

## 2a. Point interactivity at the Worker

The manifest sets an interactivity Request URL with a placeholder. After deploying the
Worker, replace it with the real host:

**Interactivity & Shortcuts** → **Request URL**:

```
https://<your-worker>.workers.dev/slack/interactions
```

Slack sends a signed test request when you save it. If it fails, the Worker is not
deployed yet or `SLACK_SIGNING_SECRET` does not match.

## 3. Install and invite

1. **OAuth & Permissions** → **Install to Workspace**.
2. Decide the channel the bot will use, and **invite it**: `/invite @Tennis TV Calendar`.
   A bot with `chat:write` can only post to channels it is a member of.
3. Copy the channel ID (channel name → **View channel details** → ID at the bottom) into
   `SLACK_CHANNEL_ID`.

## 4. Check it

Outgoing messages — run either production command with delivery disabled:

```sh
TENNISTV_PROVIDER=fixture SLACK_DRY_RUN=true npm run bot:morning:local
```

Dry run exercises everything — the block building, the safety checks, the idempotency
claims — while logging outbound messages instead of sending them.

Incoming buttons — post a message carrying them, then click one. You should get a
private confirmation that nobody else can see. `npm run worker:tail` streams the
Worker's logs while you do it.

---

## Why these scopes

The manifest asks for two bot scopes. Both are used by code that exists today.

| Scope | Used for | Why not something narrower |
| --- | --- | --- |
| `chat:write` | `chat.postMessage` for summaries and alerts; `chat.postEphemeral` for the button confirmations | Slack has no narrower posting scope, and ephemeral replies share it. |
| `channels:history` | A retried send reads recent channel history and matches the idempotency key in each message's metadata, to tell whether its earlier attempt actually landed (ARCHITECTURE.md §16.2) | Without it, an interrupted send is unresolvable: the bot must either risk a duplicate or silently lose the message. |

**If the configured channel is private**, swap `channels:history` for `groups:history`.
The bot only ever reads the one configured channel.

### What is deliberately not requested

| Not requested | Why |
| --- | --- |
| `users:read`, `users:read.email` | Mentions are rendered as `<@U…>` from stored IDs. The bot never looks a user up, and never stores a name or an email. |
| `im:write` | The bot does not DM anyone, ever (PROJECT_SPEC.md §6.1). Not holding the scope makes that structural rather than a promise. |
| `channels:read`, `channels:join` | The channel is configured, not discovered. Someone invites the bot deliberately. |
| Event subscriptions | The bot reads no messages and responds to no mentions. Button clicks arrive as interactivity, not as events. |
| `commands` | There are no slash commands. Nothing runs permanently to answer one inside Slack's three-second budget, and administration is a manually triggered GitHub Actions workflow instead. |

**Adding a scope later requires reinstalling the app** to the workspace. That is the
cost of starting minimal, and it is accepted deliberately: an unused permission on a
long-lived bot is worse.

---

## What the bot can and cannot do with this

It can post to one channel, reply privately to whoever clicks a subscription button,
and read that channel's recent history.

It cannot DM anyone, read any other channel, see a user's profile, or post anywhere but
the configured channel — the destination is read from config inside the publisher, not
passed in by callers, so there is no code path that could.

It never sends `@channel`, `@here` or `@everyone`. That is enforced twice: the block
builders never produce them, and the publisher throws if a payload contains one.

The Cloudflare Worker that receives button clicks holds **no Slack bot token at all**.
It cannot post anything: confirmations are returned in the HTTP response to the click
itself. Everything the bot says out loud is said by the GitHub Actions runner.
