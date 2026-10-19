-- User IDs are retained audit identities; account removal must not purge AI history.
-- Frozen record plans and human decisions are server-owned, never sync collections.
CREATE TABLE ai_previews (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT,
 connection_version INTEGER, request_id TEXT, result_meta TEXT NOT NULL DEFAULT '{}', tool TEXT NOT NULL, args_hash TEXT NOT NULL, workflow_id TEXT,
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
 dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dependencies_json)),
 dependency_revs TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(dependency_revs)),
 impact_json TEXT NOT NULL CHECK(json_valid(impact_json)), changeset_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','executing','completed','cancelled','conflict')),
 approved_at INTEGER, approved_session TEXT, lease_id TEXT, lease_until INTEGER, last_error TEXT
);
CREATE INDEX ai_previews_user ON ai_previews(user_id,created_at);
CREATE TABLE ai_preview_done(preview_id TEXT NOT NULL REFERENCES ai_previews(id),record_id TEXT NOT NULL,PRIMARY KEY(preview_id,record_id));
CREATE TABLE ai_workflow_changesets(workflow_id TEXT NOT NULL,user_id TEXT NOT NULL,changeset_id TEXT NOT NULL,preview_id TEXT NOT NULL,PRIMARY KEY(preview_id));

CREATE UNIQUE INDEX ai_preview_request_identity ON ai_previews(user_id,request_id) WHERE request_id IS NOT NULL;
