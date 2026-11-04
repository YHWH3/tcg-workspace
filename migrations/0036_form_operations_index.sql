-- Per-form rolling counts and bounded operational failure/follow-up lookups.
CREATE INDEX idx_submissions_form_state_created ON form_submissions(form_id,state,created_at,submission_id);
