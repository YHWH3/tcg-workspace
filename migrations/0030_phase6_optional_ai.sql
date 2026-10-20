CREATE TABLE ai_usage(day TEXT NOT NULL,kind TEXT NOT NULL,user_id TEXT NOT NULL DEFAULT 'workspace',units INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,kind,user_id));
CREATE TABLE ai_embedding_dirty(doc_id TEXT PRIMARY KEY,token INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,lease_id TEXT,lease_until INTEGER);
CREATE TABLE ai_embeddings(doc_id TEXT PRIMARY KEY,space_id TEXT,model_id TEXT NOT NULL,text_hash TEXT NOT NULL,source_rev INTEGER NOT NULL,dim INTEGER NOT NULL,vec TEXT NOT NULL CHECK(json_valid(vec)),updated_at INTEGER NOT NULL);
CREATE INDEX ai_embeddings_space ON ai_embeddings(space_id,doc_id);
CREATE TRIGGER p6_embedding_insert AFTER INSERT ON search_documents BEGIN
 INSERT INTO ai_embedding_dirty(doc_id,token) VALUES(NEW.doc_id,NEW.source_rev) ON CONFLICT(doc_id) DO UPDATE SET token=excluded.token,attempts=0,retry_at=0,lease_id=NULL,lease_until=NULL;
END;
CREATE TRIGGER p6_embedding_update AFTER UPDATE ON search_documents BEGIN
 INSERT INTO ai_embedding_dirty(doc_id,token) VALUES(NEW.doc_id,NEW.source_rev) ON CONFLICT(doc_id) DO UPDATE SET token=excluded.token,attempts=0,retry_at=0,lease_id=NULL,lease_until=NULL;
END;
CREATE TRIGGER p6_embedding_delete AFTER DELETE ON search_documents BEGIN
 DELETE FROM ai_embeddings WHERE doc_id=OLD.doc_id;
 DELETE FROM ai_embedding_dirty WHERE doc_id=OLD.doc_id;
END;
INSERT INTO ai_embedding_dirty(doc_id,token) SELECT doc_id,source_rev FROM search_documents;
CREATE TABLE ai_suggestions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,target_id TEXT NOT NULL,source_hash TEXT NOT NULL,source_rev INTEGER NOT NULL,patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),rationale TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','rejected')),created_at INTEGER NOT NULL,decided_at INTEGER,changeset_id TEXT);
CREATE INDEX ai_suggestions_user ON ai_suggestions(user_id,created_at);
CREATE TABLE ai_digest_runs(user_id TEXT NOT NULL,week TEXT NOT NULL,record_ids TEXT NOT NULL CHECK(json_valid(record_ids)),delivered INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,week));
