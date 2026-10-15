-- Bounded keyset sweeps must progress past ignored/already-sent early dates.
-- The cursor is server authority, not a generic synced record.
CREATE TABLE rhythm_sweep_cursors (
  name TEXT PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL DEFAULT '',
  field_key TEXT NOT NULL DEFAULT ''
);
-- Examined date-offset rows. Survives automation_runs retention so a later
-- sweep cannot execute the same record again for the same target date.
CREATE TABLE date_offset_marks (
  automation_id TEXT NOT NULL,
  date TEXT NOT NULL,
  field_key TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (automation_id, date, field_key, record_id)
);
CREATE INDEX idx_date_sweep ON date_index(date,record_id,field_key);
CREATE INDEX idx_notif_inbox ON notifications(user_id,created_at DESC);
DROP INDEX idx_outbox_pending;
CREATE INDEX idx_outbox_pending ON event_outbox(created_at)
  WHERE processed_at IS NULL AND terminal_at IS NULL;
CREATE INDEX idx_records_board_order ON records(collection,json_extract(data,'$.boardId'),json_extract(data,'$.order'));
CREATE INDEX idx_date_offset_run ON automation_runs(automation_id,json_extract(payload,'$.today'),json_extract(payload,'$.ev.recordId'));
