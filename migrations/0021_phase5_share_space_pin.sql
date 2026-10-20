-- Phase 5 public capability: a share token is pinned to the space its root was in when the
-- link was made (docs/architecture/phase-5-design-review.md §3 "public": token pins space_id).
-- While permissions are enabled, a token whose root has since moved to another space stops
-- serving, and nothing outside the pinned space is served through it. With permissions
-- disabled the column is ignored (Phase 0-4 behavior unchanged). Existing tokens are pinned to
-- their root's current server-owned space.
ALTER TABLE shares ADD COLUMN space_id TEXT;
UPDATE shares SET space_id = (SELECT r.space_id FROM records r WHERE r.id = shares.page_id);
