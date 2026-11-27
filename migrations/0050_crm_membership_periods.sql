-- P4 Hardening: Immutable historical period contribution requirements for Common Roots memberships
-- Strictly additive migration (#50); server-only D1 table (never in shared/collections.ts).

CREATE TABLE IF NOT EXISTS crm_membership_periods (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES crm_memberships(id) ON DELETE CASCADE,
  period_number INTEGER NOT NULL CHECK (period_number > 0),
  required_amount_minor INTEGER NOT NULL CHECK (required_amount_minor > 0),
  currency TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated')),
  invalidated_at INTEGER,
  invalidated_reason TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_membership_periods_mem
  ON crm_membership_periods(membership_id, status, period_number);
