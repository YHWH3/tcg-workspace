-- Actor IDs are retained audit references; deleting an account must not break
-- account removal. Missing issuers fail current capability validation.
-- Bearer invitation secrets are returned once; only SHA-256 hashes are retained.
CREATE TABLE guest_invites (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL REFERENCES spaces(id),
 role TEXT NOT NULL CHECK(role IN ('viewer','commenter','editor')),
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, revoked_at INTEGER,
 used_by TEXT, used_at INTEGER
);
CREATE INDEX guest_invites_space ON guest_invites(space_id,created_at,id);
