-- Chunked file storage in D1 (no R2 on this account).
-- Chunks are 1 MiB; files are capped at 20 MB and workspace quota at 450 MB.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  mime TEXT,
  size INTEGER,
  chunks INTEGER,
  uploaded_by TEXT,
  created_at INTEGER,
  complete INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE file_chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

CREATE INDEX idx_file_chunks_file ON file_chunks(file_id);
