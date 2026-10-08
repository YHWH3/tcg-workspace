-- Phase 1: expression indexes for links + views collections.
CREATE INDEX IF NOT EXISTS idx_links_from ON records(json_extract(data,'$.fromId')) WHERE collection='links';
CREATE INDEX IF NOT EXISTS idx_links_to   ON records(json_extract(data,'$.toId'))   WHERE collection='links';
CREATE INDEX IF NOT EXISTS idx_links_db   ON records(json_extract(data,'$.databaseId')) WHERE collection='links';
CREATE INDEX IF NOT EXISTS idx_views_db   ON records(json_extract(data,'$.databaseId')) WHERE collection='views';
