-- Phase 9.7: public share expiry and in-place token rotation.
ALTER TABLE shares ADD COLUMN expires_at INTEGER;
ALTER TABLE shares ADD COLUMN rotated_at INTEGER;
