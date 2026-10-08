-- Phase 1: composite expression indexes for links + views collections.
CREATE INDEX IF NOT EXISTS idx_records_links_from ON records(collection, json_extract(data,'$.fromId'));
CREATE INDEX IF NOT EXISTS idx_records_links_to   ON records(collection, json_extract(data,'$.toId'));
CREATE INDEX IF NOT EXISTS idx_records_links_db   ON records(collection, json_extract(data,'$.databaseId'));
CREATE INDEX IF NOT EXISTS idx_records_views_db   ON records(collection, json_extract(data,'$.databaseId'));
