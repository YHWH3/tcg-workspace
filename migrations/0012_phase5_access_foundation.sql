-- Additive Phase 5 foundation. Keep activation off until all server surfaces
-- and the protocol-2 client are integrated. Never rebuild/drop users: existing
-- sessions reference it with ON DELETE CASCADE.
ALTER TABLE users ADD COLUMN workspace_role TEXT CHECK(workspace_role IN ('owner','admin','member','guest'));
ALTER TABLE users ADD COLUMN disabled_at INTEGER;

CREATE TABLE access_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  generation INTEGER NOT NULL CHECK(generation > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
INSERT INTO access_state(id,generation,enabled) VALUES(1,1,0);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  default_access TEXT NOT NULL DEFAULT 'private' CHECK(default_access IN ('members','private')),
  export_policy TEXT NOT NULL DEFAULT 'disabled' CHECK(export_policy IN ('members','disabled')),
  deleted_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','commenter','viewer')),
  access TEXT NOT NULL DEFAULT 'allow' CHECK(access IN ('allow','deny')),
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(space_id,user_id)
);
CREATE INDEX idx_space_members_user ON space_members(user_id,space_id);

INSERT INTO spaces(id,name,default_access,export_policy,created_by,created_at)
VALUES('space-core','Core','members','members',
  (SELECT id FROM users WHERE role='admin' ORDER BY COALESCE(created_at,0),id LIMIT 1),0);
UPDATE users SET workspace_role='owner' WHERE id=(
  SELECT id FROM users WHERE role='admin' ORDER BY COALESCE(created_at,0),id LIMIT 1
);
INSERT INTO space_members(space_id,user_id,role,access)
  SELECT 'space-core',id,'admin','allow' FROM users WHERE role='admin' AND COALESCE(workspace_role,'')!='owner';
INSERT INTO space_members(space_id,user_id,role,access)
  SELECT 'space-core',id,'owner','allow' FROM users WHERE workspace_role='owner';

-- SQLite rejects ADD COLUMN REFERENCES with a non-NULL default on a populated
-- table. Keep the additive/backfill-safe column and enforce the same reference
-- integrity using triggers, without rebuilding records or losing its triggers.
ALTER TABLE records ADD COLUMN space_id TEXT NOT NULL DEFAULT 'space-core';
CREATE INDEX idx_records_space_seq ON records(space_id,seq);
CREATE TRIGGER p5_record_space_insert BEFORE INSERT ON records
WHEN NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id) BEGIN
  SELECT RAISE(ABORT,'unknown_record_space');
END;
CREATE TRIGGER p5_record_space_update BEFORE UPDATE OF space_id ON records
WHEN NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id) BEGIN
  SELECT RAISE(ABORT,'unknown_record_space');
END;
CREATE TRIGGER p5_space_referenced BEFORE DELETE ON spaces
WHEN EXISTS(SELECT 1 FROM records WHERE space_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'space_has_records');
END;

CREATE TABLE access_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  space_id TEXT,
  target_user_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  args_hash TEXT,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(actor_id,request_id)
);
CREATE INDEX idx_access_audit_space ON access_audit(space_id,created_at,id);

-- Epoch changes are transactional with the authority change. An interrupted
-- application handler cannot forget to invalidate an old snapshot/guard.
CREATE TRIGGER p5_space_insert AFTER INSERT ON spaces BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_space_update AFTER UPDATE OF name,default_access,export_policy,deleted_at ON spaces
WHEN OLD.name IS NOT NEW.name OR OLD.default_access IS NOT NEW.default_access
  OR OLD.export_policy IS NOT NEW.export_policy OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_space_delete AFTER DELETE ON spaces BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_member_insert AFTER INSERT ON space_members BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_member_update AFTER UPDATE OF role,access ON space_members
WHEN OLD.role IS NOT NEW.role OR OLD.access IS NOT NEW.access BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_member_delete AFTER DELETE ON space_members BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_user_insert AFTER INSERT ON users BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_user_update AFTER UPDATE OF role,workspace_role,disabled_at ON users
WHEN OLD.role IS NOT NEW.role OR OLD.workspace_role IS NOT NEW.workspace_role OR OLD.disabled_at IS NOT NEW.disabled_at BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_user_delete AFTER DELETE ON users BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
-- Revoked sessions must also invalidate in-flight write fences. Session
-- creation/TTL renewal does not alter content access; expiry is checked by auth.
CREATE TRIGGER p5_session_delete AFTER DELETE ON sessions BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER p5_record_scope AFTER UPDATE OF space_id ON records
WHEN OLD.space_id IS NOT NEW.space_id BEGIN
  UPDATE access_state SET generation=generation+1 WHERE id=1;
END;
