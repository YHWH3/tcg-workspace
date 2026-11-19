-- Retain body ownership at the time of each new block revision.
-- NULL metadata on earlier history remains explicitly unattributed.
ALTER TABLE record_history ADD COLUMN before_parent_id TEXT;
ALTER TABLE record_history ADD COLUMN after_parent_id TEXT;
ALTER TABLE record_history ADD COLUMN was_created INTEGER;
CREATE INDEX record_history_before_parent ON record_history(before_parent_id,revision DESC);
CREATE INDEX record_history_after_parent ON record_history(after_parent_id,revision DESC);
