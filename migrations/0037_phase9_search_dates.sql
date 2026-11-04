-- Phase 9.6: date-aware search metadata. These columns are derived from the
-- records row and JSON payload; the search index remains reconstructible.
ALTER TABLE search_documents ADD COLUMN updated_at INTEGER;
ALTER TABLE search_documents ADD COLUMN created_at INTEGER;
CREATE INDEX idx_search_documents_updated ON search_documents(updated_at);
CREATE INDEX idx_search_documents_created ON search_documents(created_at);
