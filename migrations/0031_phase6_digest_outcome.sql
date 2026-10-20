-- Additive delivery evidence; delivered remains the legacy terminal-processing flag.
ALTER TABLE ai_digest_runs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'pending'
 CHECK(outcome IN ('pending','delivered','no_content','preferences_off'));
