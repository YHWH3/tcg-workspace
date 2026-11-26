-- P2 S10 Contact Merge & Reversible Alias Resolution (server-only tables, never in COLLECTIONS).

-- Canonical alias lookup table: merged (loser) person ID -> canonical survivor person ID.
CREATE TABLE crm_person_aliases (
  alias_id TEXT PRIMARY KEY,
  survivor_id TEXT NOT NULL,
  merge_id TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (alias_id != survivor_id)
);
CREATE INDEX crm_person_aliases_survivor
  ON crm_person_aliases(survivor_id, effective_at DESC, alias_id);
CREATE INDEX crm_person_aliases_merge
  ON crm_person_aliases(merge_id);

-- Immutable merge journal: every moved reference + pre/post state for reversible unmerge.
CREATE TABLE crm_merges (
  id TEXT PRIMARY KEY,
  survivor_id TEXT NOT NULL,
  merged_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  moved_json TEXT NOT NULL,
  post_record_revs_json TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  created_at INTEGER NOT NULL,
  CHECK (survivor_id != merged_id)
);
CREATE INDEX crm_merges_created
  ON crm_merges(created_at DESC, id DESC);
CREATE INDEX crm_merges_survivor
  ON crm_merges(survivor_id, created_at DESC, id DESC);
CREATE INDEX crm_merges_merged
  ON crm_merges(merged_id, created_at DESC, id DESC);

CREATE TRIGGER crm_merges_no_update BEFORE UPDATE ON crm_merges
BEGIN SELECT RAISE(ABORT, 'crm_merges is append-only'); END;
CREATE TRIGGER crm_merges_no_delete BEFORE DELETE ON crm_merges
BEGIN SELECT RAISE(ABORT, 'crm_merges is append-only'); END;

-- Append-only unmerge ledger referencing crm_merges(id); PRIMARY KEY prevents double unmerge.
CREATE TABLE crm_merge_unmerges (
  merge_id TEXT PRIMARY KEY REFERENCES crm_merges(id),
  unmerge_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX crm_merge_unmerges_created
  ON crm_merge_unmerges(created_at DESC, unmerge_id DESC);

CREATE TRIGGER crm_merge_unmerges_no_update BEFORE UPDATE ON crm_merge_unmerges
BEGIN SELECT RAISE(ABORT, 'crm_merge_unmerges is append-only'); END;
CREATE TRIGGER crm_merge_unmerges_no_delete BEFORE DELETE ON crm_merge_unmerges
BEGIN SELECT RAISE(ABORT, 'crm_merge_unmerges is append-only'); END;
