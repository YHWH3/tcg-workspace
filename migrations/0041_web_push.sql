CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  UNIQUE(user_id, id)
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
ALTER TABLE email_outbox ADD COLUMN push_subscription_id TEXT REFERENCES push_subscriptions(id) ON DELETE CASCADE;
