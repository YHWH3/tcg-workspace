-- Additive Phase 5 per-space feed schema (docs/architecture/phase-5-per-space-feeds.md).
-- Nothing here changes behavior while access_state.enabled = 0, and nothing from
-- migrations 0012-0016 is rewritten (certification hash-locks them).

-- Record revisions must never regress. records.seq is allocated as MAX(seq)+1; a hard
-- delete of the current maximum (abandoned public-upload cleanup) would let the next
-- write reuse a value some client cursor already passed. The floor remembers the
-- highest revision ever deleted and allocation takes max(max(seq), floor)+1.
CREATE TABLE seq_floor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  floor INTEGER NOT NULL DEFAULT 0 CHECK(floor >= 0)
);
INSERT INTO seq_floor(id, floor) VALUES(1, 0);
CREATE TRIGGER p5_seq_floor AFTER DELETE ON records BEGIN
  UPDATE seq_floor SET floor = MAX(floor, OLD.seq) WHERE id = 1;
END;

-- Per-space retained eviction facts. A row says: record_id left space_id at revision
-- seq. seq is the moved row's new records.seq (same counter domain, never a content
-- copy). A cursor older than events_floor cannot prove completeness for that space.
ALTER TABLE spaces ADD COLUMN events_floor INTEGER NOT NULL DEFAULT 0;
CREATE TABLE space_events (
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('evict')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(space_id, seq)
) WITHOUT ROWID;
CREATE INDEX idx_space_events_created ON space_events(created_at, space_id, seq);

-- The other readable space of a cross-space relation. A link's own revision does not
-- change when the space of its other endpoint is regranted, so the home-space index
-- alone can never find it again. NULL for everything else.
ALTER TABLE records ADD COLUMN peer_space_id TEXT;
CREATE INDEX idx_records_peer_seq ON records(peer_space_id, seq) WHERE peer_space_id IS NOT NULL;
UPDATE records SET peer_space_id = (
  SELECT t.space_id FROM records t WHERE t.id = json_extract(records.data, '$.toId') AND t.space_id <> records.space_id
) WHERE collection = 'links';

-- A record leaving a space (explicit move). Same statement as the cause.
CREATE TRIGGER p5_space_event_move AFTER UPDATE OF space_id ON records
WHEN OLD.space_id IS NOT NEW.space_id BEGIN
  INSERT OR IGNORE INTO space_events(space_id, seq, record_id, kind, created_at)
  VALUES(OLD.space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

-- A link retargeted without changing its home space: the previous audience (home and
-- peer) must drop it. OR IGNORE: a move that also retargets emits the same fact twice.
CREATE TRIGGER p5_space_event_link_retarget AFTER UPDATE OF data ON records
WHEN NEW.collection = 'links' AND (
  json_extract(OLD.data, '$.fromId') IS NOT json_extract(NEW.data, '$.fromId')
  OR json_extract(OLD.data, '$.toId') IS NOT json_extract(NEW.data, '$.toId')
  OR json_extract(OLD.data, '$.fromType') IS NOT json_extract(NEW.data, '$.fromType')
  OR json_extract(OLD.data, '$.toType') IS NOT json_extract(NEW.data, '$.toType')) BEGIN
  INSERT OR IGNORE INTO space_events(space_id, seq, record_id, kind, created_at)
  VALUES(OLD.space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000);
  INSERT OR IGNORE INTO space_events(space_id, seq, record_id, kind, created_at)
  SELECT OLD.peer_space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE OLD.peer_space_id IS NOT NULL AND OLD.peer_space_id IS NOT OLD.space_id;
END;
