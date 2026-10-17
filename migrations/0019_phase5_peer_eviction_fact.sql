-- A relation changes its peer space when its OTHER endpoint moves (or gains/loses a second
-- space). Its home space does not change, and neither does its data. Migration 0017 emitted
-- eviction facts only for a home change (the record moved) and for a retarget (fromId/toId
-- changed), so the audience that could read the relation before and cannot read it now
-- (it reads the home but not the new peer) received no fact and had to discover the loss by
-- sweeping for dangling relations on the client.
--
-- A relation is delivered only to someone who can read EVERY space it touches, so every
-- holder of the old row can read its old home space: one fact for the old home reaches the
-- whole audience that may have lost it. Readers who can still read the new peer receive the
-- row again at the same revision, and the revision rule keeps it (docs/architecture/
-- phase-5-per-space-feeds.md, FD-02). OR IGNORE: a move that also re-homes or retargets the
-- link emits the same fact from the other triggers; facts are keyed (space_id, seq).
CREATE TRIGGER p5_space_event_peer_change AFTER UPDATE OF peer_space_id ON records
WHEN OLD.peer_space_id IS NOT NEW.peer_space_id BEGIN
  INSERT OR IGNORE INTO space_events(space_id, seq, record_id, kind, created_at)
  VALUES(OLD.space_id, NEW.seq, NEW.id, 'evict', CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
