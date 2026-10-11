-- Durable leases and logical side-effect deduplication. Existing Phase 4
-- rows are retained and mapped honestly; failed work is recoverable.
ALTER TABLE event_outbox ADD COLUMN lease_id TEXT;
ALTER TABLE event_outbox ADD COLUMN lease_until INTEGER;
ALTER TABLE event_outbox ADD COLUMN terminal_at INTEGER;
CREATE INDEX idx_outbox_recovery ON event_outbox(processed_at,terminal_at,lease_until,created_at);

CREATE TABLE notification_deliveries (
  delivery_key TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE execution_steps (
  operation_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,step_id)
);

ALTER TABLE automation_runs RENAME TO automation_runs_legacy;
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, event_key TEXT UNIQUE NOT NULL,
  changeset_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','retryable_failure','terminal_failure')),
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT, lease_until INTEGER, payload TEXT, plan TEXT
);
INSERT INTO automation_runs(id,automation_id,event_key,changeset_id,status,error,created_at)
SELECT id,automation_id,event_key,changeset_id,
  CASE WHEN status='ok' THEN 'completed' ELSE 'retryable_failure' END,error,created_at
FROM automation_runs_legacy;
DROP TABLE automation_runs_legacy;
CREATE INDEX idx_runs_auto ON automation_runs(automation_id,created_at DESC);
CREATE INDEX idx_runs_recovery ON automation_runs(status,retry_at,lease_until);

ALTER TABLE form_submissions RENAME TO form_submissions_legacy;
CREATE TABLE form_submissions (
  submission_id TEXT PRIMARY KEY, form_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','retryable_failure','rejected','accepted')),
  receipt TEXT, record_id TEXT, error TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER,
  request_hash TEXT, payload TEXT, plan TEXT, changeset_id TEXT
);
INSERT INTO form_submissions(submission_id,form_id,state,receipt,record_id,error,created_at)
SELECT submission_id,form_id,state,receipt,record_id,error,created_at FROM form_submissions_legacy;
DROP TABLE form_submissions_legacy;
CREATE INDEX idx_submissions_recovery ON form_submissions(state,retry_at,lease_until);

-- Public email matching reserves a normalized key without disclosing it.
CREATE TABLE form_people_keys (
  database_id TEXT NOT NULL, field_key TEXT NOT NULL, email TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY(database_id,field_key,email)
);
