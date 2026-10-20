-- Retire the unshipped generation + materialized-snapshot reconciliation
-- (docs/architecture/phase-5-per-space-feeds.md section 3.8). Forward only: 0012-0016 stay
-- hash-locked. Every consumer of access_state.generation was converted to the caller's
-- capability fence first, so dropping these triggers cannot degrade any fail-closed check.
-- access_state.generation stays as an inert column (access_audit rows still copy it).

-- Every logout, expiry, password change, soft delete, restore and re-parent used to bump a
-- global counter and send every client through a full snapshot. Nothing does now.
DROP TRIGGER IF EXISTS p5_space_insert;
DROP TRIGGER IF EXISTS p5_space_update;
DROP TRIGGER IF EXISTS p5_space_delete;
DROP TRIGGER IF EXISTS p5_member_insert;
DROP TRIGGER IF EXISTS p5_member_update;
DROP TRIGGER IF EXISTS p5_member_delete;
DROP TRIGGER IF EXISTS p5_user_insert;
DROP TRIGGER IF EXISTS p5_user_update;
DROP TRIGGER IF EXISTS p5_user_delete;
DROP TRIGGER IF EXISTS p5_session_delete;
DROP TRIGGER IF EXISTS p5_record_scope;
DROP TRIGGER IF EXISTS p5_record_visibility;
DROP TRIGGER IF EXISTS p5_record_delete_visibility;
DROP TRIGGER IF EXISTS p5_access_activation;
DROP TRIGGER IF EXISTS p5_file_aux_visibility;

-- Snapshots were frozen copies of readable records; the per-space feed copies nothing.
DROP TABLE IF EXISTS sync_snapshot_items;
DROP TABLE IF EXISTS sync_snapshots;
