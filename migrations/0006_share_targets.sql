ALTER TABLE shares ADD COLUMN target_type TEXT NOT NULL DEFAULT 'page';
CREATE UNIQUE INDEX IF NOT EXISTS shares_target_page ON shares (target_type, page_id);
