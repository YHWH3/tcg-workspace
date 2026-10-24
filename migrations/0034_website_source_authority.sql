-- Server-only source dependencies and an explicit, revocable ingest grant.
CREATE TABLE body_generations (record_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
INSERT INTO body_generations SELECT json_extract(data,'$.pageId'),1 FROM records
 WHERE collection='blocks' AND json_extract(data,'$.pageId') IS NOT NULL GROUP BY json_extract(data,'$.pageId');
CREATE TRIGGER body_generation_insert AFTER INSERT ON records WHEN NEW.collection='blocks' BEGIN
 INSERT INTO body_generations SELECT json_extract(NEW.data,'$.pageId'),1 WHERE json_extract(NEW.data,'$.pageId') IS NOT NULL
 ON CONFLICT(record_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER body_generation_update AFTER UPDATE ON records WHEN (OLD.collection='blocks' OR NEW.collection='blocks') AND OLD.data IS NOT NEW.data BEGIN
 INSERT INTO body_generations SELECT json_extract(OLD.data,'$.pageId'),1 WHERE OLD.collection='blocks' AND json_extract(OLD.data,'$.pageId') IS NOT NULL
 ON CONFLICT(record_id) DO UPDATE SET generation=generation+1;
 INSERT INTO body_generations SELECT json_extract(NEW.data,'$.pageId'),1 WHERE NEW.collection='blocks' AND json_extract(NEW.data,'$.pageId') IS NOT NULL
 ON CONFLICT(record_id) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER body_generation_delete AFTER DELETE ON records WHEN OLD.collection='blocks' BEGIN
 INSERT INTO body_generations SELECT json_extract(OLD.data,'$.pageId'),1 WHERE json_extract(OLD.data,'$.pageId') IS NOT NULL
 ON CONFLICT(record_id) DO UPDATE SET generation=generation+1;
END;
ALTER TABLE ai_suggestions ADD COLUMN source_bodies TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_previews ADD COLUMN source_bodies TEXT NOT NULL DEFAULT '{}';
CREATE TABLE website_ingest_grant (
 id INTEGER PRIMARY KEY CHECK(id=1), sponsor_id TEXT NOT NULL,
 space_id TEXT NOT NULL, inbox_id TEXT NOT NULL, people_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, revoked_at INTEGER, updated_at INTEGER NOT NULL
);

CREATE INDEX website_ingest_person ON website_ingest(json_extract(result,'$.personId')) WHERE state='accepted';
