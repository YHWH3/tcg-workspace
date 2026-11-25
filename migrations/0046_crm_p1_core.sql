-- P1 Core CRM operational tables (server-only, never in COLLECTIONS).
-- Note: migrations/0045_crm_foundation.sql already created crm_commands, crm_capability_grants, crm_capability_audit.

-- S1 Identity: contact endpoints, append-only consent log, duplicate review candidates.
CREATE TABLE crm_endpoints (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'whatsapp', 'instagram', 'facebook')),
  value_raw TEXT NOT NULL CHECK (length(value_raw) BETWEEN 1 AND 320),
  value_norm TEXT NOT NULL CHECK (length(value_norm) BETWEEN 1 AND 320),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  verified_at INTEGER,
  retired_at INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX crm_endpoints_active_unique
  ON crm_endpoints(kind, value_norm)
  WHERE retired_at IS NULL;
CREATE UNIQUE INDEX crm_endpoints_primary_unique
  ON crm_endpoints(person_id, kind)
  WHERE is_primary = 1 AND retired_at IS NULL;
CREATE INDEX crm_endpoints_person
  ON crm_endpoints(person_id, kind, retired_at, is_primary DESC);

CREATE TABLE crm_consents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'any')),
  scope TEXT NOT NULL CHECK (scope IN ('transactional', 'updates', 'documentation', 'publication')),
  status TEXT NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  source TEXT NOT NULL,
  evidence_ref TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX crm_consents_latest
  ON crm_consents(person_id, channel, scope, recorded_at DESC, id DESC);
CREATE TRIGGER crm_consents_no_update BEFORE UPDATE ON crm_consents
BEGIN SELECT RAISE(ABORT, 'crm_consents is append-only'); END;
CREATE TRIGGER crm_consents_no_delete BEFORE DELETE ON crm_consents
BEGIN SELECT RAISE(ABORT, 'crm_consents is append-only'); END;

CREATE TABLE crm_duplicate_candidates (
  id TEXT PRIMARY KEY,
  person_a_id TEXT NOT NULL,
  person_b_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'dismissed', 'merged')),
  decided_by TEXT,
  decided_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL,
  CHECK (person_a_id < person_b_id),
  UNIQUE (person_a_id, person_b_id)
);
CREATE INDEX crm_duplicate_candidates_state
  ON crm_duplicate_candidates(state, created_at DESC, id DESC);

-- S2 Programme Registry profiles
CREATE TABLE crm_programme_profiles (
  slug TEXT PRIMARY KEY,
  programme_record_id TEXT,
  work_area TEXT NOT NULL CHECK (work_area IN (
    'experiences_learning',
    'spaces_network',
    'community_support',
    'collaboration_work',
    'culture_making'
  )),
  name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- S4 Conversations core & operational verified knowledge store
CREATE TABLE crm_channel_accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook')),
  label TEXT NOT NULL,
  external_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('simulated', 'disabled')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel, external_id)
);

CREATE TABLE crm_conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'call', 'in_person')),
  channel_account_id TEXT,
  external_thread_id TEXT,
  person_id TEXT,
  organisation_id TEXT,
  programme_slug TEXT,
  application_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'snoozed', 'closed', 'spam')),
  assignee_id TEXT,
  window_expires_at INTEGER,
  last_message_at INTEGER NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  unread_count INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_conversations_state_time
  ON crm_conversations(state, last_message_at DESC, id DESC);
CREATE INDEX crm_conversations_person_time
  ON crm_conversations(person_id, last_message_at DESC, id DESC);
CREATE INDEX crm_conversations_assignee_state
  ON crm_conversations(assignee_id, state, last_message_at DESC, id DESC);
CREATE INDEX crm_conversations_thread
  ON crm_conversations(channel, external_thread_id);

CREATE TABLE crm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  status TEXT NOT NULL CHECK (status IN ('received', 'draft', 'queued', 'sending', 'sent', 'delivered', 'failed', 'note')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'call', 'in_person', 'internal')),
  sender_endpoint TEXT,
  recipient_endpoint TEXT,
  author_user_id TEXT,
  body_text TEXT NOT NULL,
  body_html_sanitized TEXT,
  external_message_id TEXT,
  template_id TEXT,
  ai_metadata_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_messages_conv_time
  ON crm_messages(conversation_id, created_at ASC, id ASC);

CREATE TABLE crm_outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES crm_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  channel_account_id TEXT,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,
  last_error TEXT,
  provider_receipt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE crm_inbound_events (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook')),
  channel_account_id TEXT,
  external_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processed', 'ignored', 'failed')),
  conversation_id TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (channel, external_event_id)
);

CREATE TABLE crm_templates (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'facebook', 'email')),
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'utility',
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
  body_text TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE crm_facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',
  programme_slug TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'retired')),
  review_by INTEGER,
  verified_by TEXT,
  verified_at INTEGER,
  retired_by TEXT,
  retired_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_facts_status_prog
  ON crm_facts(status, programme_slug, updated_at DESC, id DESC);
