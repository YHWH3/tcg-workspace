-- Conservative directory policy: a space containing the canonical People
-- directory is unavailable to guests until an independently approved policy.
-- This is a sticky server-owned restriction. Archive, rename, delete or move
-- must not silently re-expose retained contacts/history. No API clears it.
ALTER TABLE spaces ADD COLUMN guest_directory_restricted INTEGER NOT NULL DEFAULT 0 CHECK(guest_directory_restricted IN (0,1));
UPDATE spaces SET guest_directory_restricted=1 WHERE id IN (
 SELECT space_id FROM records WHERE collection='boards' AND (
 json_extract(data,'$.templateDbKey')='people' OR
 (json_extract(data,'$.templateKey')='starter-people' AND json_extract(data,'$.name')='People') OR
 (json_extract(data,'$.kind')='records' AND lower(json_extract(data,'$.name'))='people'))
);
CREATE TRIGGER directory_privacy_insert AFTER INSERT ON records
WHEN NEW.collection='boards' AND (json_extract(NEW.data,'$.templateDbKey')='people' OR
 (json_extract(NEW.data,'$.templateKey')='starter-people' AND json_extract(NEW.data,'$.name')='People') OR
 (json_extract(NEW.data,'$.kind')='records' AND lower(json_extract(NEW.data,'$.name'))='people')) BEGIN
 UPDATE spaces SET guest_directory_restricted=1 WHERE id=NEW.space_id AND guest_directory_restricted=0;
END;
CREATE TRIGGER directory_privacy_update AFTER UPDATE ON records
WHEN NEW.collection='boards' AND (json_extract(NEW.data,'$.templateDbKey')='people' OR
 (json_extract(NEW.data,'$.templateKey')='starter-people' AND json_extract(NEW.data,'$.name')='People') OR
 (json_extract(NEW.data,'$.kind')='records' AND lower(json_extract(NEW.data,'$.name'))='people')) BEGIN
 UPDATE spaces SET guest_directory_restricted=1 WHERE id=NEW.space_id AND guest_directory_restricted=0;
END;
