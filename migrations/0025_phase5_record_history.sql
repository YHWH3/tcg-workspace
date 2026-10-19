-- Field deltas only. Retained indefinitely until an owner-approved retention policy.
CREATE TABLE record_history (
 record_id TEXT NOT NULL, revision INTEGER NOT NULL, collection TEXT NOT NULL,
 actor_id TEXT NOT NULL, source TEXT NOT NULL, changeset_id TEXT,
 space_id TEXT NOT NULL, peer_space_id TEXT, created_at INTEGER NOT NULL,
 before_json TEXT NOT NULL, after_json TEXT NOT NULL, omitted_json TEXT NOT NULL,
 PRIMARY KEY(record_id,revision)
);
CREATE INDEX record_history_time ON record_history(created_at,record_id,revision);
CREATE TABLE history_restore_jobs (
 user_id TEXT NOT NULL, request_id TEXT NOT NULL, args_hash TEXT NOT NULL,
 record_id TEXT NOT NULL, changeset_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id)
);
