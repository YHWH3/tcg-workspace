-- Embedded assistant (feature/unified-ai-mcp). Additive, server-only tables:
-- never synced collections, never exposed without the session-authenticated API.
-- Conversations expire (default 30 days, user-selectable) and are revalidated
-- against current access whenever they are reopened.
CREATE TABLE assistant_conversations(
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL DEFAULT 'New conversation',
 provider TEXT,
 model TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 expires_at INTEGER
);
CREATE INDEX assistant_conversations_user ON assistant_conversations(user_id,updated_at);
CREATE INDEX assistant_conversations_expiry ON assistant_conversations(expires_at);
CREATE TABLE assistant_messages(
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN('user','assistant','tool')),
 content_json TEXT NOT NULL CHECK(json_valid(content_json)),
 source_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ids)),
 created_at INTEGER NOT NULL,
 UNIQUE(conversation_id,seq)
);
-- One active run per conversation. `step` is the compare-and-set token: a
-- duplicate/replayed continue request for an already-consumed step is refused.
CREATE TABLE assistant_runs(
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 session_hash TEXT NOT NULL,
 provider TEXT NOT NULL,
 model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('running','awaiting_continue','awaiting_approval','completed','failed','cancelled')),
 step INTEGER NOT NULL DEFAULT 0,
 pending_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(pending_json)),
 context_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context_json)),
 action_id TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 error_code TEXT,
 input_chars INTEGER NOT NULL DEFAULT 0,
 output_chars INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX assistant_runs_active ON assistant_runs(conversation_id) WHERE status IN('running','awaiting_continue');
CREATE INDEX assistant_runs_user ON assistant_runs(user_id,updated_at);
-- Bring-your-own-key provider credentials, AES-GCM encrypted with the operator
-- secret AI_CREDENTIAL_KEY. Ciphertext is bound (AAD) to user and provider.
CREATE TABLE assistant_credentials(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,
 ciphertext TEXT NOT NULL,
 iv TEXT NOT NULL,
 key_version INTEGER NOT NULL DEFAULT 1,
 models_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(models_json)),
 created_at INTEGER NOT NULL,
 last_used_at INTEGER,
 PRIMARY KEY(user_id,provider)
);
CREATE TABLE assistant_settings(
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days IN(7,30,90)),
 updated_at INTEGER NOT NULL
);
