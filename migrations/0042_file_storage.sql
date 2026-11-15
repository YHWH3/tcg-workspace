-- Completed-byte locations remain private server metadata. Uploads still stage in D1.
ALTER TABLE files ADD COLUMN storage TEXT NOT NULL DEFAULT 'd1' CHECK(storage IN ('d1','r2'));
ALTER TABLE files ADD COLUMN r2_key TEXT;
ALTER TABLE files ADD COLUMN sha256 TEXT;
CREATE INDEX idx_files_storage ON files(storage,complete);
-- Persist external work before a put, and preserve it before 0011 reclaims metadata.
CREATE TABLE file_storage_jobs (
 file_id TEXT PRIMARY KEY,
 object_key TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('copy','delete')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_file_storage_pending ON file_storage_jobs(next_attempt_at,file_id);
CREATE TRIGGER file_storage_delete BEFORE DELETE ON files
 WHEN OLD.storage='r2' OR EXISTS(SELECT 1 FROM file_storage_jobs WHERE file_id=OLD.id)
 BEGIN
 INSERT INTO file_storage_jobs(file_id,object_key,operation,created_at)
 VALUES(OLD.id,COALESCE(OLD.r2_key,'files/'||OLD.id),'delete',COALESCE(OLD.created_at,0))
 ON CONFLICT(file_id) DO UPDATE SET operation='delete',next_attempt_at=0,last_error=NULL;
END;
-- A late copy cannot recreate an identifier after metadata reclamation.
CREATE TRIGGER file_storage_reserve AFTER DELETE ON files
 WHEN EXISTS(SELECT 1 FROM file_storage_jobs WHERE file_id=OLD.id AND operation='delete')
 BEGIN
 INSERT INTO file_deletions(id,created_at)
 SELECT OLD.id,COALESCE(OLD.created_at,0)
 WHERE NOT EXISTS(SELECT 1 FROM file_deletions WHERE id=OLD.id);
END;
