-- Disposable, account/epoch-bound reconciliation snapshots. This is not record
-- history or a backup: stale/expired sessions are never readable and are pruned.
CREATE TABLE sync_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 64),
  generation INTEGER NOT NULL,
  cutoff INTEGER NOT NULL,
  page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 500),
  cursor_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(user_id,request_id)
);
CREATE INDEX idx_sync_snapshot_expiry ON sync_snapshots(expires_at,id);
CREATE INDEX idx_sync_snapshot_user ON sync_snapshots(user_id,expires_at);

CREATE TABLE sync_snapshot_items (
  snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  data TEXT NOT NULL,
  field_ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(snapshot_id,ordinal),
  UNIQUE(snapshot_id,record_id)
);
