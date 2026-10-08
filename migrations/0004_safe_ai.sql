-- Phase 0: safe AI editing — requestId dedupe, change sets, undo data,
-- and the expression indexes behind targeted reads (§3, §5, §7, §11).

CREATE TABLE IF NOT EXISTS mcp_requests (
  user_id    TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool       TEXT NOT NULL,
  args_hash  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  result     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_requests_created ON mcp_requests (created_at);

CREATE TABLE IF NOT EXISTS changesets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('mcp', 'automation', 'form', 'undo')),
  client_name TEXT,
  tool       TEXT NOT NULL,
  summary    TEXT NOT NULL,
  request_id TEXT,
  undoes     TEXT,
  undone_by  TEXT,
  item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changesets_user    ON changesets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_changesets_created ON changesets (created_at DESC);

CREATE TABLE IF NOT EXISTS changeset_items (
  changeset_id TEXT NOT NULL REFERENCES changesets(id),
  idx          INTEGER NOT NULL,
  collection   TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  created      INTEGER NOT NULL DEFAULT 0,
  before       TEXT NOT NULL,
  after        TEXT NOT NULL,
  field_ts     TEXT NOT NULL,
  PRIMARY KEY (changeset_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_changeset_items_record ON changeset_items (record_id);

-- Expression indexes so MCP reads hit specific parents instead of scanning
-- the collection (verified with EXPLAIN QUERY PLAN in e2e).
CREATE INDEX IF NOT EXISTS idx_records_collection ON records (collection);
CREATE INDEX IF NOT EXISTS idx_records_page       ON records (collection, json_extract(data, '$.pageId'));
CREATE INDEX IF NOT EXISTS idx_records_board      ON records (collection, json_extract(data, '$.boardId'));
CREATE INDEX IF NOT EXISTS idx_records_parent     ON records (collection, json_extract(data, '$.parentId'));
CREATE INDEX IF NOT EXISTS idx_records_target     ON records (collection, json_extract(data, '$.targetId'));
