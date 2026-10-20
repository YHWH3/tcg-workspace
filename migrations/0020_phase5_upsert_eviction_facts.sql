-- The outer records UPSERT conflict policy overrides OR IGNORE inside a trigger.
-- A retarget plus a peer change can emit the same fact from two triggers. Use an
-- explicit existence predicate instead, within the same atomic record statement.
DROP TRIGGER p5_space_event_move;
DROP TRIGGER p5_space_event_link_retarget;
DROP TRIGGER p5_space_event_peer_change;
CREATE TRIGGER p5_space_event_move AFTER UPDATE OF space_id ON records
WHEN OLD.space_id IS NOT NEW.space_id BEGIN
  INSERT INTO space_events(space_id, seq, record_id, kind, created_at)
  SELECT OLD.space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE NOT EXISTS(SELECT 1 FROM space_events WHERE space_id=OLD.space_id AND seq=NEW.seq);
END;

-- A link retargeted without changing its home space: the previous audience (home and
-- peer) must drop it. The existence predicates deduplicate overlapping triggers.
CREATE TRIGGER p5_space_event_link_retarget AFTER UPDATE OF data ON records
WHEN NEW.collection = 'links' AND (
  json_extract(OLD.data, '$.fromId') IS NOT json_extract(NEW.data, '$.fromId')
  OR json_extract(OLD.data, '$.toId') IS NOT json_extract(NEW.data, '$.toId')
  OR json_extract(OLD.data, '$.fromType') IS NOT json_extract(NEW.data, '$.fromType')
  OR json_extract(OLD.data, '$.toType') IS NOT json_extract(NEW.data, '$.toType')) BEGIN
  INSERT INTO space_events(space_id, seq, record_id, kind, created_at)
  SELECT OLD.space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE NOT EXISTS(SELECT 1 FROM space_events WHERE space_id=OLD.space_id AND seq=NEW.seq);
  INSERT INTO space_events(space_id, seq, record_id, kind, created_at)
  SELECT OLD.peer_space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE OLD.peer_space_id IS NOT NULL AND OLD.peer_space_id IS NOT OLD.space_id
    AND NOT EXISTS(SELECT 1 FROM space_events WHERE space_id=OLD.peer_space_id AND seq=NEW.seq);
END;

CREATE TRIGGER p5_space_event_peer_change AFTER UPDATE OF peer_space_id ON records
WHEN OLD.peer_space_id IS NOT NEW.peer_space_id BEGIN
  INSERT INTO space_events(space_id, seq, record_id, kind, created_at)
  SELECT OLD.space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE NOT EXISTS(SELECT 1 FROM space_events WHERE space_id=OLD.space_id AND seq=NEW.seq);
END;
