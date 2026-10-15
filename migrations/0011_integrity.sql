-- Durable deletion intent survives browser loss and upload/delete races.
CREATE TABLE file_deletions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO file_deletions SELECT id,COALESCE(updated_at,0) FROM records WHERE collection='files' AND json_extract(data,'$.deleted')=1;
INSERT OR IGNORE INTO file_deletions SELECT json_extract(data,'$.thumbId'),COALESCE(updated_at,0) FROM records WHERE collection='files' AND json_extract(data,'$.deleted')=1 AND json_extract(data,'$.thumbId') IS NOT NULL;
CREATE TRIGGER file_tombstone_insert AFTER INSERT ON records WHEN NEW.collection='files' AND json_extract(NEW.data,'$.deleted')=1 BEGIN
 INSERT INTO file_deletions SELECT NEW.id,COALESCE(NEW.updated_at,0) WHERE NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=NEW.id);
 INSERT INTO file_deletions SELECT json_extract(NEW.data,'$.thumbId'),COALESCE(NEW.updated_at,0) WHERE json_extract(NEW.data,'$.thumbId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=json_extract(NEW.data,'$.thumbId'));
END;
CREATE TRIGGER file_tombstone_update AFTER UPDATE ON records WHEN NEW.collection='files' AND json_extract(NEW.data,'$.deleted')=1 BEGIN
 INSERT INTO file_deletions SELECT NEW.id,COALESCE(NEW.updated_at,0) WHERE NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=NEW.id);
 INSERT INTO file_deletions SELECT json_extract(NEW.data,'$.thumbId'),COALESCE(NEW.updated_at,0) WHERE json_extract(NEW.data,'$.thumbId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=json_extract(NEW.data,'$.thumbId'));
END;
-- A view keeps the ownership rule identical for immediate and legacy cleanup.
-- Attachments have one parent; explicit block/cover/thumbnail references can
-- share bytes (e.g. template instantiation), so retain those until released.
CREATE INDEX idx_block_file_ref ON records(CAST(json_extract(data,'$.fileId') AS TEXT)) WHERE collection IN ('blocks','mooditems') AND COALESCE(json_extract(data,'$.deleted'),0)=0;
CREATE INDEX idx_task_cover_ref ON records(CAST(json_extract(data,'$.coverFileId') AS TEXT)) WHERE collection='tasks' AND COALESCE(json_extract(data,'$.deleted'),0)=0;
CREATE INDEX idx_file_thumb_ref ON records(CAST(json_extract(data,'$.thumbId') AS TEXT)) WHERE collection='files' AND COALESCE(json_extract(data,'$.deleted'),0)=0;
CREATE VIEW reclaimable_files AS SELECT d.id FROM file_deletions d
 WHERE NOT EXISTS(SELECT 1 FROM records r INDEXED BY idx_block_file_ref WHERE r.collection IN ('blocks','mooditems') AND COALESCE(json_extract(r.data,'$.deleted'),0)=0 AND CAST(json_extract(r.data,'$.fileId') AS TEXT)=d.id)
 AND NOT EXISTS(SELECT 1 FROM records r INDEXED BY idx_task_cover_ref WHERE r.collection='tasks' AND COALESCE(json_extract(r.data,'$.deleted'),0)=0 AND CAST(json_extract(r.data,'$.coverFileId') AS TEXT)=d.id)
 AND NOT EXISTS(SELECT 1 FROM records r INDEXED BY idx_file_thumb_ref WHERE r.collection='files' AND COALESCE(json_extract(r.data,'$.deleted'),0)=0 AND CAST(json_extract(r.data,'$.thumbId') AS TEXT)=d.id);
CREATE TRIGGER file_reclaim_insert AFTER INSERT ON records WHEN NEW.collection IN ('files','blocks','tasks','mooditems') BEGIN
 DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM reclaimable_files WHERE id IN (NEW.id,json_extract(NEW.data,'$.fileId'),json_extract(NEW.data,'$.coverFileId'),json_extract(NEW.data,'$.thumbId')));
 DELETE FROM files WHERE id IN (SELECT id FROM reclaimable_files WHERE id IN (NEW.id,json_extract(NEW.data,'$.fileId'),json_extract(NEW.data,'$.coverFileId'),json_extract(NEW.data,'$.thumbId')));
END;
CREATE TRIGGER file_reclaim_update AFTER UPDATE ON records WHEN NEW.collection IN ('files','blocks','tasks','mooditems') BEGIN
 DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM reclaimable_files WHERE id IN (NEW.id,json_extract(OLD.data,'$.fileId'),json_extract(OLD.data,'$.coverFileId'),json_extract(OLD.data,'$.thumbId'),json_extract(NEW.data,'$.fileId'),json_extract(NEW.data,'$.coverFileId'),json_extract(NEW.data,'$.thumbId')));
 DELETE FROM files WHERE id IN (SELECT id FROM reclaimable_files WHERE id IN (NEW.id,json_extract(OLD.data,'$.fileId'),json_extract(OLD.data,'$.coverFileId'),json_extract(OLD.data,'$.thumbId'),json_extract(NEW.data,'$.fileId'),json_extract(NEW.data,'$.coverFileId'),json_extract(NEW.data,'$.thumbId')));
END;
-- Reclaim on intent insertion too, so the tombstone transaction does not
-- depend on the unspecified ordering of same-event SQLite triggers.
CREATE TRIGGER file_reclaim_intent AFTER INSERT ON file_deletions BEGIN
 DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM reclaimable_files WHERE id=NEW.id);
 DELETE FROM files WHERE id IN (SELECT id FROM reclaimable_files WHERE id=NEW.id);
END;
DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM reclaimable_files);
DELETE FROM files WHERE id IN (SELECT id FROM reclaimable_files);
CREATE TRIGGER file_no_resurrection BEFORE INSERT ON files WHEN EXISTS(SELECT 1 FROM file_deletions WHERE id=NEW.id) BEGIN
 SELECT RAISE(ABORT,'file deleted');
END;
CREATE TRIGGER chunk_no_resurrection BEFORE INSERT ON file_chunks WHEN EXISTS(SELECT 1 FROM file_deletions WHERE id=NEW.file_id) BEGIN
 SELECT RAISE(ABORT,'file deleted');
END;

-- Undo has a stable inverse changeset and a frozen per-record plan. A record,
-- its inverse journal and its completion checkpoint commit in one D1 batch.
CREATE TABLE undo_jobs (
 changeset_id TEXT PRIMARY KEY, inverse_id TEXT NOT NULL, user_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', lease_id TEXT, lease_until INTEGER,
 skipped TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE TABLE undo_items (
 changeset_id TEXT NOT NULL, record_id TEXT NOT NULL, collection TEXT NOT NULL,
 patch TEXT NOT NULL, expected_rev INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 conflict TEXT, PRIMARY KEY(changeset_id,record_id)
);
CREATE INDEX idx_undo_pending ON undo_items(changeset_id,state);
CREATE TABLE mcp_write_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL,
 plan TEXT NOT NULL, expectations TEXT NOT NULL, args_hash TEXT, lease_id TEXT, lease_until INTEGER, cancelled INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,request_id,tool)
);
CREATE TABLE mcp_write_done (job_id TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(job_id,record_id));
