-- Calendar snapshots: the schedule, frozen, so a modal can open instantly.
--
-- The Worker must answer a button click inside Slack's three-second interaction
-- deadline, and it deliberately knows nothing about Tennis TV. So the GitHub Actions
-- morning job writes the schedule here, and the Worker only reads.
--
-- Stored as normalised JSON rather than rendered Slack blocks: rendering is
-- presentation and changes often, and freezing today's layout into stored state would
-- need a migration every time the design moved.

CREATE TABLE calendar_snapshots (
  -- `week:2026-W40` or `month:2026-09`.
  period_key   TEXT NOT NULL,
  -- LIVE or TEST. Part of the key, so a simulation writes alongside the real schedule
  -- rather than over it — a drill can never blank a production calendar.
  variant      TEXT NOT NULL CHECK (variant IN ('LIVE', 'TEST')),
  period_type  TEXT NOT NULL CHECK (period_type IN ('WEEK', 'MONTH')),
  -- When the schedule was read from Tennis TV, so a view can say how fresh it is.
  generated_at TEXT NOT NULL,
  -- The normalised snapshot. One row per period, replaced wholesale on each refresh.
  payload_json TEXT NOT NULL,
  PRIMARY KEY (period_key, variant)
) WITHOUT ROWID;

-- Retention sweeps delete by age; without this they would scan the table.
CREATE INDEX idx_calendar_snapshots_generated ON calendar_snapshots (generated_at);
