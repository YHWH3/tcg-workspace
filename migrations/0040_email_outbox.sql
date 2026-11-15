ALTER TABLE workspace_settings ADD COLUMN email_show_titles INTEGER NOT NULL DEFAULT 0 CHECK (email_show_titles IN (0, 1));

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  notification_id TEXT,
  digest_key TEXT,
  target_id TEXT,
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT,
  sent_at INTEGER,
  provider_id TEXT,
  last_error TEXT,
  terminal_at INTEGER,
  UNIQUE (user_id, digest_key)
);
CREATE INDEX idx_email_outbox_pending ON email_outbox(next_attempt_at, created_at) WHERE sent_at IS NULL AND terminal_at IS NULL;
CREATE INDEX idx_email_outbox_user ON email_outbox(user_id);
