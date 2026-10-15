-- Phase 4: server-controlled operational tables (never synced collections —
-- generic push/pull cannot write them; access via authenticated endpoints only).

ALTER TABLE users ADD COLUMN prefs TEXT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  group_key TEXT,
  group_count INTEGER NOT NULL DEFAULT 1,
  items TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX idx_notif_group ON notifications(user_id, group_key, read_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stage_id TEXT,
  requested_by TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')),
  note TEXT,
  decided_note TEXT,
  request_key TEXT UNIQUE,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_approval_target ON approvals(target_type, target_id);
CREATE INDEX idx_approval_approver ON approvals(approver_id, status);

CREATE TABLE form_tokens (
  token TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE form_submissions (
  submission_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('rejected','processing','accepted')),
  receipt TEXT,
  record_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);

CREATE TABLE date_index (
  record_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (record_id, field_key, date)
);
CREATE INDEX idx_date_date ON date_index(date);

CREATE TABLE reminder_sent (
  record_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (record_id, field_key, date, kind)
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  event_key TEXT UNIQUE NOT NULL,
  changeset_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('ok','failed')),
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_auto ON automation_runs(automation_id, created_at DESC);

CREATE TABLE event_outbox (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX idx_outbox_pending ON event_outbox(processed_at);
