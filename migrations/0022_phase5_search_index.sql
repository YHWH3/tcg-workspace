-- Phase 5 permission-aware search index (docs/architecture/phase-5-implementation.md §9,
-- design review §6). search_documents is authoritative and server-only (never synced);
-- search_fts is reconstructible from it (rowid = search_documents.rowid) and is never part of
-- a backup workflow. A document is one page, record, database or mood board; page and record
-- bodies aggregate their live block text.
--
-- Freshness: every write of a document's own row or of one of its blocks marks the document
-- dirty IN THE SAME STATEMENT (triggers), so edits, moves, soft deletes and restores can
-- never be missed. The processor (worker/search.ts) rebuilds a dirty document from current
-- records and removes the dirty key only if no newer write arrived (token = newest seq).
-- Queries never serve a dirty document from the index; they match its live content instead.
CREATE TABLE search_documents (
  doc_id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  space_id TEXT,
  database_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_rev INTEGER NOT NULL
);
CREATE INDEX idx_search_documents_space ON search_documents(space_id, collection);
CREATE VIRTUAL TABLE search_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE search_dirty (
  doc_id TEXT PRIMARY KEY,
  token INTEGER NOT NULL
);
CREATE INDEX idx_search_dirty_token ON search_dirty(token);

CREATE TRIGGER p5_search_dirty_insert AFTER INSERT ON records
WHEN NEW.collection IN ('pages','tasks','boards','moodboards')
  OR (NEW.collection = 'blocks' AND json_extract(NEW.data,'$.pageId') IS NOT NULL) BEGIN
  INSERT INTO search_dirty(doc_id, token)
  VALUES(CASE WHEN NEW.collection = 'blocks' THEN json_extract(NEW.data,'$.pageId') ELSE NEW.id END, NEW.seq)
  ON CONFLICT(doc_id) DO UPDATE SET token = MAX(token, excluded.token);
END;

CREATE TRIGGER p5_search_dirty_update AFTER UPDATE ON records
WHEN NEW.collection IN ('pages','tasks','boards','moodboards')
  OR (NEW.collection = 'blocks' AND (json_extract(NEW.data,'$.pageId') IS NOT NULL OR json_extract(OLD.data,'$.pageId') IS NOT NULL)) BEGIN
  INSERT INTO search_dirty(doc_id, token)
  SELECT CASE WHEN NEW.collection = 'blocks' THEN json_extract(NEW.data,'$.pageId') ELSE NEW.id END, NEW.seq
  WHERE (CASE WHEN NEW.collection = 'blocks' THEN json_extract(NEW.data,'$.pageId') ELSE NEW.id END) IS NOT NULL
  ON CONFLICT(doc_id) DO UPDATE SET token = MAX(token, excluded.token);
  INSERT INTO search_dirty(doc_id, token)
  SELECT json_extract(OLD.data,'$.pageId'), NEW.seq
  WHERE NEW.collection = 'blocks' AND json_extract(OLD.data,'$.pageId') IS NOT NULL
    AND json_extract(OLD.data,'$.pageId') IS NOT json_extract(NEW.data,'$.pageId')
  ON CONFLICT(doc_id) DO UPDATE SET token = MAX(token, excluded.token);
END;

-- Every existing document starts dirty; the processor builds the index from current rows.
INSERT OR IGNORE INTO search_dirty(doc_id, token)
SELECT id, seq FROM records WHERE collection IN ('pages','tasks','boards','moodboards');
