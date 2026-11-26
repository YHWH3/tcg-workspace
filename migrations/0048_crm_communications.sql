-- TCG CRM P3 Communications (S5 Zoho Mail, S11 WhatsApp Cloud API, S12 Instagram & Facebook)
-- Server-only operational tables (never in shared/collections.ts).

-- 1. Rebuild crm_channel_accounts with provider, production mode (disabled by default), durable poll cursors & health fields
ALTER TABLE crm_channel_accounts RENAME TO crm_channel_accounts_p1_legacy;

CREATE TABLE crm_channel_accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook')),
  provider TEXT NOT NULL DEFAULT 'simulated' CHECK (provider IN ('email_zoho', 'whatsapp_cloud', 'instagram_meta', 'facebook_meta', 'simulated')),
  label TEXT NOT NULL,
  external_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('simulated', 'production', 'disabled')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  secret_name TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  poll_cursor TEXT,
  poll_lease_until INTEGER,
  last_poll_at INTEGER,
  health_state TEXT NOT NULL DEFAULT 'disconnected' CHECK (health_state IN ('disconnected', 'connected', 'degraded', 'error')),
  last_error TEXT,
  last_error_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel, external_id)
);

INSERT INTO crm_channel_accounts (
  id, channel, provider, label, external_id, mode, active, secret_name, config_json,
  poll_cursor, poll_lease_until, last_poll_at, health_state, last_error, last_error_at,
  rev, created_by, created_at, updated_at
)
SELECT
  id,
  channel,
  'simulated',
  label,
  external_id,
  mode,
  active,
  NULL,
  config_json,
  NULL,
  NULL,
  NULL,
  CASE WHEN mode = 'simulated' AND active = 1 THEN 'connected' ELSE 'disconnected' END,
  NULL,
  NULL,
  1,
  created_by,
  created_at,
  updated_at
FROM crm_channel_accounts_p1_legacy;

DROP TABLE crm_channel_accounts_p1_legacy;

CREATE INDEX crm_channel_accounts_channel_mode
  ON crm_channel_accounts(channel, mode, active);

-- 2. Extend crm_conversations with 7-day Meta Human Agent window & RFC 5322 email threading metadata
ALTER TABLE crm_conversations ADD COLUMN human_agent_window_expires_at INTEGER;
ALTER TABLE crm_conversations ADD COLUMN last_rfc_message_id TEXT;
ALTER TABLE crm_conversations ADD COLUMN email_subject_norm TEXT;

-- 3. Preserve crm_outbox in staging table so crm_messages can be rebuilt cleanly without FK conflicts
CREATE TABLE crm_outbox_p3_stage AS SELECT * FROM crm_outbox;
DROP TABLE crm_outbox;

-- 4. Rebuild crm_messages with read/review_required/cancelled statuses, RFC 5322 headers, tags & delivery timestamps
ALTER TABLE crm_messages RENAME TO crm_messages_p1_legacy;

CREATE TABLE crm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  status TEXT NOT NULL CHECK (status IN ('received', 'draft', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'review_required', 'cancelled', 'note')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'call', 'in_person', 'internal')),
  sender_endpoint TEXT,
  recipient_endpoint TEXT,
  author_user_id TEXT,
  body_text TEXT NOT NULL,
  body_html_sanitized TEXT,
  external_message_id TEXT,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  template_id TEXT,
  template_params_json TEXT,
  message_tag TEXT,
  ai_metadata_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  sent_at INTEGER,
  delivered_at INTEGER,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO crm_messages (
  id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint,
  author_user_id, body_text, body_html_sanitized, external_message_id,
  rfc_message_id, in_reply_to, references_json, template_id, template_params_json, message_tag,
  ai_metadata_json, error_code, error_detail, sent_at, delivered_at, read_at, created_at, updated_at
)
SELECT
  id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint,
  author_user_id, body_text, body_html_sanitized, external_message_id,
  NULL, NULL, NULL, template_id, NULL, NULL,
  ai_metadata_json, error_code, error_detail, sent_at, NULL, NULL, created_at, updated_at
FROM crm_messages_p1_legacy;

DROP TABLE crm_messages_p1_legacy;

CREATE INDEX crm_messages_conv_time
  ON crm_messages(conversation_id, created_at ASC, id ASC);
CREATE INDEX crm_messages_rfc_id
  ON crm_messages(rfc_message_id) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX crm_messages_external_id
  ON crm_messages(channel, external_message_id) WHERE external_message_id IS NOT NULL;

-- 5. Recreate crm_outbox with leases, error classification, consent purpose, ambiguous review_required & cancelled states
CREATE TABLE crm_outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES crm_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  channel_account_id TEXT,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'review_required', 'cancelled')),
  purpose TEXT NOT NULL DEFAULT 'transactional' CHECK (purpose IN ('transactional', 'updates', 'documentation', 'publication')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at INTEGER,
  lease_until INTEGER,
  last_error_class TEXT,
  last_error TEXT,
  provider_receipt TEXT,
  idempotency_key TEXT,
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO crm_outbox (
  id, message_id, conversation_id, channel_account_id, actor_id, request_id,
  status, purpose, attempts, max_attempts, next_attempt_at, lease_until,
  last_error_class, last_error, provider_receipt, idempotency_key,
  resolution_note, resolved_by, resolved_at, created_at, updated_at
)
SELECT
  id, message_id, conversation_id, channel_account_id, actor_id, request_id,
  status, 'transactional', attempts, max_attempts, next_attempt_at, NULL,
  NULL, last_error, provider_receipt, request_id,
  NULL, NULL, NULL, created_at, updated_at
FROM crm_outbox_p3_stage;

DROP TABLE crm_outbox_p3_stage;

CREATE INDEX crm_outbox_due
  ON crm_outbox(status, next_attempt_at ASC, created_at ASC);
CREATE INDEX crm_outbox_lease
  ON crm_outbox(status, lease_until ASC);
CREATE INDEX crm_outbox_conv
  ON crm_outbox(conversation_id, created_at DESC);

-- 6. Rebuild crm_templates with full provider lifecycle (submitted, approved, rejected, paused, retired)
ALTER TABLE crm_templates RENAME TO crm_templates_p1_legacy;

CREATE TABLE crm_templates (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'facebook', 'email')),
  channel_account_id TEXT,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'utility' CHECK (category IN ('utility', 'marketing', 'authentication', 'service')),
  provider_template_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paused', 'retired')),
  body_text TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '[]',
  rejection_reason TEXT,
  submitted_at INTEGER,
  approved_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO crm_templates (
  id, channel, channel_account_id, name, language, category, provider_template_id,
  status, body_text, variables_json, rejection_reason, submitted_at, approved_at,
  rev, created_by, created_at, updated_at
)
SELECT
  id, channel, NULL, name, language,
  CASE WHEN category IN ('utility', 'marketing', 'authentication', 'service') THEN category ELSE 'utility' END,
  NULL, status, body_text, variables_json, NULL, NULL,
  CASE WHEN status = 'approved' THEN updated_at ELSE NULL END,
  1, created_by, created_at, updated_at
FROM crm_templates_p1_legacy;

DROP TABLE crm_templates_p1_legacy;

CREATE INDEX crm_templates_channel_status
  ON crm_templates(channel, status, updated_at DESC);

-- 7. Inbound event lookup index by account
CREATE INDEX crm_inbound_events_account_time
  ON crm_inbound_events(channel_account_id, created_at DESC);
