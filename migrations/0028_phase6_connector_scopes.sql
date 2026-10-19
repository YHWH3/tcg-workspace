-- User IDs are retained audit identities; account removal must not purge AI history.
-- Server-owned connector bounds, independent of OAuth token refresh lifetimes.
CREATE TABLE ai_connections (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
 spaces_json TEXT NOT NULL CHECK(json_valid(spaces_json)), version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX ai_connections_user ON ai_connections(user_id,created_at);
CREATE TABLE ai_scope_consents (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL,
 client_id TEXT NOT NULL, request_json TEXT NOT NULL, cookie_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
