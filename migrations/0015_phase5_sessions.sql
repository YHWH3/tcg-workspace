-- Additive session controls. Existing credentials/expiry remain unchanged.
ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN device_label TEXT NOT NULL DEFAULT 'Unknown device';
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
UPDATE sessions SET id=lower(hex(randomblob(16))),last_seen_at=created_at;
CREATE UNIQUE INDEX idx_sessions_id ON sessions(id);
CREATE INDEX idx_sessions_owner_page ON sessions(user_id,created_at DESC,id DESC);
-- Older callers and upgrade fixtures may omit metadata. They still receive an
-- opaque ID without exposing the credential hash or changing the token.
CREATE TRIGGER p5_session_metadata AFTER INSERT ON sessions WHEN NEW.id IS NULL BEGIN
  UPDATE sessions SET id=lower(hex(randomblob(16))),last_seen_at=COALESCE(NEW.last_seen_at,NEW.created_at)
    WHERE token_hash=NEW.token_hash;
END;
