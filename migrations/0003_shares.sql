CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  page_id TEXT UNIQUE NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
