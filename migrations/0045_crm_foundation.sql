CREATE TABLE crm_commands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('ui','mcp','automation','ingest')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 64),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  result TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(result AS BLOB)) <= 16384),
  created_at INTEGER NOT NULL,
  UNIQUE (actor_id, request_id)
);
CREATE INDEX crm_commands_actor_time ON crm_commands(actor_id, created_at);

CREATE TABLE crm_capability_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (user_id, capability, scope)
);

CREATE TABLE crm_capability_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant','revoke')),
  capability TEXT NOT NULL,
  scope TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (actor_id, request_id)
);
CREATE INDEX crm_capability_audit_time ON crm_capability_audit(created_at, id);
CREATE TRIGGER crm_capability_audit_no_update BEFORE UPDATE ON crm_capability_audit
BEGIN SELECT RAISE(ABORT, 'crm_capability_audit is append-only'); END;
CREATE TRIGGER crm_capability_audit_no_delete BEFORE DELETE ON crm_capability_audit
BEGIN SELECT RAISE(ABORT, 'crm_capability_audit is append-only'); END;
