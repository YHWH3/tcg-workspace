-- P4 Operational CRM: S6 Editions & Bookings, S7 Manual Financial Operations, S8 Common Roots Membership
-- All tables are server-only D1 operational tables (never in shared/collections.ts).

CREATE TABLE crm_editions (
  id TEXT PRIMARY KEY,
  event_record_id TEXT NOT NULL UNIQUE,
  programme_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  hold_minutes INTEGER CHECK (hold_minutes IS NULL OR hold_minutes > 0),
  max_group_size INTEGER CHECK (max_group_size IS NULL OR max_group_size > 0),
  confirm_before_payment INTEGER CHECK (confirm_before_payment IS NULL OR confirm_before_payment IN (0, 1)),
  requires_screening INTEGER NOT NULL DEFAULT 0 CHECK (requires_screening IN (0, 1)),
  screening_questions_json TEXT,
  cancellation_policy_text TEXT,
  price_options_json TEXT NOT NULL DEFAULT '[]',
  session_dates_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'open', 'closed', 'cancelled', 'completed')),
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_editions_programme_state ON crm_editions(programme_slug, state, updated_at DESC);

CREATE TABLE crm_bookings (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES crm_editions(id),
  booker_person_id TEXT NOT NULL,
  application_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN (
      'request',
      'held',
      'awaiting_payment',
      'confirmed',
      'waitlisted',
      'offered',
      'paid_without_seat',
      'cancelled',
      'expired',
      'completed'
    )
  ),
  seats INTEGER NOT NULL CHECK (seats > 0),
  price_option_id TEXT,
  unit_amount_minor INTEGER CHECK (unit_amount_minor IS NULL OR unit_amount_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  hold_expires_at INTEGER,
  offer_expires_at INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (
    payment_status IN ('unpaid', 'part_paid', 'paid', 'overpaid', 'refund_pending', 'refunded')
  ),
  cancel_reason TEXT,
  source TEXT NOT NULL DEFAULT 'crm',
  notes TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_bookings_edition_state ON crm_bookings(edition_id, state, created_at ASC);
CREATE INDEX crm_bookings_booker ON crm_bookings(booker_person_id, created_at DESC);
CREATE INDEX crm_bookings_holds ON crm_bookings(state, hold_expires_at);

CREATE TABLE crm_allocations (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES crm_editions(id),
  booking_id TEXT NOT NULL REFERENCES crm_bookings(id),
  seats INTEGER NOT NULL CHECK (seats > 0),
  kind TEXT NOT NULL CHECK (kind IN ('hold', 'confirmed')),
  expires_at INTEGER,
  released_at INTEGER,
  release_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_allocations_edition_active ON crm_allocations(edition_id, released_at, kind, expires_at);
CREATE INDEX crm_allocations_booking_active ON crm_allocations(booking_id, released_at);

CREATE TABLE crm_participants (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES crm_bookings(id),
  edition_id TEXT NOT NULL REFERENCES crm_editions(id),
  person_id TEXT,
  display_name TEXT NOT NULL,
  placeholder_index INTEGER,
  state TEXT NOT NULL CHECK (state IN ('placeholder', 'named', 'cancelled')),
  notes TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_participants_booking ON crm_participants(booking_id, placeholder_index ASC, id ASC);
CREATE INDEX crm_participants_edition ON crm_participants(edition_id, state);
CREATE INDEX crm_participants_person ON crm_participants(person_id);

CREATE TABLE crm_attendance (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES crm_participants(id),
  edition_id TEXT NOT NULL REFERENCES crm_editions(id),
  session_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('present', 'absent', 'partial', 'not_recorded')),
  notes TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (participant_id, session_date)
);
CREATE INDEX crm_attendance_edition_date ON crm_attendance(edition_id, session_date);

CREATE TABLE crm_screenings (
  participant_id TEXT PRIMARY KEY REFERENCES crm_participants(id),
  booking_id TEXT NOT NULL REFERENCES crm_bookings(id),
  edition_id TEXT NOT NULL REFERENCES crm_editions(id),
  programme_slug TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  evidence_note TEXT,
  state TEXT NOT NULL CHECK (state IN ('requested', 'received', 'reviewed', 'cleared', 'not_suitable')),
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_screenings_booking ON crm_screenings(booking_id);
CREATE INDEX crm_screenings_programme ON crm_screenings(programme_slug, state);

CREATE TABLE crm_payment_requests (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('booking', 'membership')),
  object_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  programme_slug TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  state TEXT NOT NULL CHECK (state IN ('draft', 'issued', 'part_paid', 'paid', 'overpaid', 'cancelled', 'expired')),
  due_at INTEGER,
  label TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_payment_requests_object ON crm_payment_requests(object_type, object_id, created_at DESC);
CREATE INDEX crm_payment_requests_person ON crm_payment_requests(person_id, created_at DESC);
CREATE INDEX crm_payment_requests_programme ON crm_payment_requests(programme_slug, currency);

CREATE TABLE crm_ledger_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'reversal', 'refund', 'adjustment')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  object_type TEXT NOT NULL CHECK (object_type IN ('booking', 'membership')),
  object_id TEXT NOT NULL,
  payment_request_id TEXT REFERENCES crm_payment_requests(id),
  person_id TEXT NOT NULL,
  programme_slug TEXT,
  evidence_kind TEXT NOT NULL CHECK (
    evidence_kind IN ('bank_reference', 'proof_file', 'cash_voucher', 'provider_event', 'reversal_reason', 'refund_reference')
  ),
  evidence_ref TEXT NOT NULL,
  evidence_note TEXT,
  contributor_residency TEXT NOT NULL DEFAULT 'domestic' CHECK (contributor_residency IN ('domestic')),
  reverses_entry_id TEXT UNIQUE REFERENCES crm_ledger_entries(id),
  refund_request_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX crm_ledger_object ON crm_ledger_entries(object_type, object_id, currency, recorded_at ASC);
CREATE INDEX crm_ledger_person ON crm_ledger_entries(person_id, recorded_at DESC);
CREATE INDEX crm_ledger_programme_currency ON crm_ledger_entries(programme_slug, currency, recorded_at DESC);

CREATE TRIGGER crm_ledger_entries_no_update
BEFORE UPDATE ON crm_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'crm_ledger_entries is append-only');
END;

CREATE TRIGGER crm_ledger_entries_no_delete
BEFORE DELETE ON crm_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'crm_ledger_entries is append-only');
END;

CREATE TABLE crm_refund_policies (
  currency TEXT PRIMARY KEY CHECK (length(currency) = 3 AND currency = upper(currency)),
  dual_approval_threshold_minor INTEGER CHECK (dual_approval_threshold_minor IS NULL OR dual_approval_threshold_minor >= 0),
  allow_foreign_contributions INTEGER NOT NULL DEFAULT 0 CHECK (allow_foreign_contributions = 0),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE crm_refund_requests (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('booking', 'membership')),
  object_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  programme_slug TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'approved', 'rejected', 'issued', 'cancelled')),
  requires_independent_approval INTEGER NOT NULL DEFAULT 1 CHECK (requires_independent_approval IN (0, 1)),
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  decision_note TEXT,
  issued_entry_id TEXT REFERENCES crm_ledger_entries(id),
  issued_by TEXT,
  issued_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_refund_requests_object ON crm_refund_requests(object_type, object_id, requested_at DESC);
CREATE INDEX crm_refund_requests_state ON crm_refund_requests(state, requested_at DESC);

CREATE TABLE crm_membership_schemes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  programme_slug TEXT NOT NULL DEFAULT 'common-roots',
  contribution_amount_minor INTEGER CHECK (contribution_amount_minor IS NULL OR contribution_amount_minor > 0),
  currency TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  validity_days INTEGER CHECK (validity_days IS NULL OR validity_days > 0),
  renewal_notice_days INTEGER CHECK (renewal_notice_days IS NULL OR renewal_notice_days > 0),
  identifier_prefix TEXT,
  identifier_digits INTEGER CHECK (identifier_digits IS NULL OR (identifier_digits >= 2 AND identifier_digits <= 10)),
  next_identifier_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_identifier_seq > 0),
  benefits_enabled INTEGER NOT NULL DEFAULT 0 CHECK (benefits_enabled = 0),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE crm_memberships (
  id TEXT PRIMARY KEY,
  scheme_id TEXT NOT NULL REFERENCES crm_membership_schemes(id),
  person_id TEXT NOT NULL,
  application_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN (
      'applied',
      'approved',
      'declined',
      'awaiting_contribution',
      'active',
      'renewal_due',
      'lapsed',
      'cancelled'
    )
  ),
  member_identifier TEXT UNIQUE,
  valid_from INTEGER,
  valid_until INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (
    payment_status IN ('unpaid', 'part_paid', 'paid', 'overpaid', 'refund_pending', 'refunded')
  ),
  period_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  decision_reason TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX crm_memberships_person_state ON crm_memberships(person_id, state, created_at DESC);
CREATE INDEX crm_memberships_scheme_state ON crm_memberships(scheme_id, state);
CREATE INDEX crm_memberships_expiry ON crm_memberships(state, valid_until);
