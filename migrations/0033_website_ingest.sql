-- Signed server-to-server inbox for The Common Ground website relay
-- (worker/websiteIngest.ts). Server-only: never a synced collection.
-- event_id is the relay's idempotency key; body_hash detects a reused id
-- with a different body (409). Rows stay 'pending' until the record write and
-- admin notifications have committed, so a relay retry re-runs safely.
CREATE TABLE website_ingest (
  event_id TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  event TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted')),
  record_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
