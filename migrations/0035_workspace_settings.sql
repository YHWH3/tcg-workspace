-- Server-only calendar and currency preferences. UTC preserves legacy behavior.
CREATE TABLE IF NOT EXISTS workspace_settings (
 id TEXT PRIMARY KEY CHECK (id = 'workspace'),
 time_zone TEXT NOT NULL DEFAULT 'UTC',
 currency TEXT NOT NULL DEFAULT 'INR',
 week_start INTEGER NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
 updated_by TEXT,
 updated_at INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO workspace_settings(id,time_zone,currency,week_start,updated_at)
VALUES ('workspace','UTC','INR',1,0);
