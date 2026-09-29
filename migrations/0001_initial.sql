-- TTV Calendar Bot — initial D1 schema.
--
-- Three tables, and no more. The PostgreSQL schema this replaces had seven, but most
-- of what it stored was either derivable from Tennis TV on demand (tournaments,
-- matches, schedules) or was bookkeeping for a long-running process that no longer
-- exists (sync runs, scheduled-summary run rows, migration metadata). What genuinely
-- cannot be recomputed is:
--
--   1. who opted in                  — exists nowhere else
--   2. what we last saw a match as   — the basis of every transition decision
--   3. what we have already sent     — the basis of every duplicate decision
--
-- Rationale for each table is in docs/ARCHITECTURE.md. Retention is handled by the
-- cron tick, so these tables stay small enough that the free tier is never in question.

-- ---------------------------------------------------------------------------
-- Who is opted in to live alerts.
-- ---------------------------------------------------------------------------
-- Keyed by workspace + channel + user, so the same person in two channels (or the
-- app installed in two workspaces) is two independent subscriptions. This is also
-- the uniqueness constraint that makes repeated clicks harmless: a second opt-in
-- collides with the first and updates it rather than inserting a duplicate.
CREATE TABLE subscriptions (
  team_id    TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  -- Kept as a row with enabled = 0 rather than deleted: an opt-out is information,
  -- and keeping it means "you are already opted out" is answerable.
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (team_id, channel_id, user_id)
) WITHOUT ROWID;

-- The monitor's only read: "who should I mention in this channel". Covering index,
-- so it never degrades into a scan as opt-outs accumulate.
CREATE INDEX idx_subscriptions_recipients ON subscriptions (channel_id, enabled, user_id);

-- ---------------------------------------------------------------------------
-- The last state we observed for each match.
-- ---------------------------------------------------------------------------
-- The Worker is stateless between invocations, so this table is the *entire* memory
-- of the state machine. Without it every cron tick would see each live match as new.
--
-- Only what a transition decision needs is stored. Player names, rounds and courts are
-- re-read from Tennis TV in the same invocation that renders an alert, so storing them
-- would be duplicating the upstream rather than remembering something.
CREATE TABLE match_state (
  -- `tournamentId:year:matchId` — MatchId alone collides across tournaments.
  match_key      TEXT NOT NULL PRIMARY KEY,
  tournament_key TEXT NOT NULL,
  -- Normalised MatchStatus, never a raw provider code.
  status         TEXT NOT NULL,
  -- ISO-8601 UTC, or NULL when Tennis TV has not published a start time.
  starts_at_utc  TEXT,
  observed_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) WITHOUT ROWID;

-- Retention sweeps delete by age; without this they would scan the table.
CREATE INDEX idx_match_state_updated ON match_state (updated_at);

-- ---------------------------------------------------------------------------
-- What has already been sent.
-- ---------------------------------------------------------------------------
-- One ledger for both kinds of "post this exactly once", because they are the same
-- problem with different keys:
--
--   ALERT   4713:2026:MS011:LIVE
--   REPORT  daily:2026-09-14 / weekly:2026-W38 / monthly:2026-09
--
-- Splitting them into two tables would duplicate the claim/settle logic for no gain,
-- and the primary key is what enforces the guarantee in both cases.
CREATE TABLE notifications (
  idempotency_key TEXT    NOT NULL PRIMARY KEY,
  kind            TEXT    NOT NULL CHECK (kind IN ('ALERT', 'REPORT')),
  -- The match or occurrence the key refers to, for diagnostics and retention.
  reference       TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('PENDING', 'SENT', 'SUPPRESSED', 'ABANDONED')),
  attempts        INTEGER NOT NULL DEFAULT 1,
  slack_ts        TEXT,
  recipient_count INTEGER,
  last_error      TEXT,
  claimed_at      TEXT    NOT NULL,
  settled_at      TEXT
) WITHOUT ROWID;

-- Finds claims a previous invocation left unsettled, and drives retention.
CREATE INDEX idx_notifications_status ON notifications (status, claimed_at);
