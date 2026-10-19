-- Additional canonical documents; inherited authority is checked at read time.
DROP TRIGGER p5_search_dirty_insert;
DROP TRIGGER p5_search_dirty_update;
CREATE TRIGGER p5_search_dirty_insert AFTER INSERT ON records BEGIN
 INSERT INTO search_dirty(doc_id,token) SELECT CASE WHEN NEW.collection='blocks' THEN json_extract(NEW.data,'$.pageId') ELSE NEW.id END,NEW.seq
 WHERE NEW.collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems','blocks')
 AND (NEW.collection!='blocks' OR json_extract(NEW.data,'$.pageId') IS NOT NULL)
 ON CONFLICT(doc_id) DO UPDATE SET token=MAX(token,excluded.token);
END;
CREATE TRIGGER p5_search_dirty_update AFTER UPDATE ON records BEGIN
 INSERT INTO search_dirty(doc_id,token) SELECT CASE WHEN NEW.collection='blocks' THEN json_extract(NEW.data,'$.pageId') ELSE NEW.id END,NEW.seq
 WHERE NEW.collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems','blocks')
 AND (NEW.collection!='blocks' OR json_extract(NEW.data,'$.pageId') IS NOT NULL)
 ON CONFLICT(doc_id) DO UPDATE SET token=MAX(token,excluded.token);
 INSERT INTO search_dirty(doc_id,token) SELECT json_extract(OLD.data,'$.pageId'),NEW.seq
 WHERE OLD.collection='blocks' AND json_extract(OLD.data,'$.pageId') IS NOT NULL
 ON CONFLICT(doc_id) DO UPDATE SET token=MAX(token,excluded.token);
END;
CREATE TRIGGER p5_search_dirty_delete AFTER DELETE ON records BEGIN
 INSERT INTO search_dirty(doc_id,token) SELECT CASE WHEN OLD.collection='blocks' THEN json_extract(OLD.data,'$.pageId') ELSE OLD.id END,OLD.seq+1
 WHERE OLD.collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems','blocks')
 AND (OLD.collection!='blocks' OR json_extract(OLD.data,'$.pageId') IS NOT NULL)
 ON CONFLICT(doc_id) DO UPDATE SET token=MAX(token,excluded.token);
END;
INSERT INTO search_dirty(doc_id,token) SELECT id,seq FROM records WHERE collection IN ('pages','tasks','boards','moodboards','comments','files','mooditems')
ON CONFLICT(doc_id) DO UPDATE SET token=MAX(token,excluded.token);
