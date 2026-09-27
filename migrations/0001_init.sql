CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE,
  name TEXT,
  password_hash TEXT,
  salt TEXT,
  role TEXT CHECK(role IN ('admin','member')),
  color TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  data TEXT NOT NULL,
  field_ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(seq);
