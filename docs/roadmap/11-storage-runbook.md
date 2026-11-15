# Phase 11 storage runbook

D1 remains the default. Migration 0042 adds private byte location metadata and a
recovery queue. Uploads still stage in 1 MiB chunks and accept files up to 20 MB.
The shared quota defaults to 450 MiB. Settings reads it from the server.

## Owner activation

1. Review supported R2 billing and confirm the current account's checkout
   requirements. Cloudflare lists a monthly Standard allowance of 10 GB-month,
   1 million Class A requests and 10 million Class B requests. Checkout
   requirements depend on the account. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
   and [R2 setup](https://developers.cloudflare.com/r2/get-started/).
2. Create a private bucket in the approved account. Leave public access off.
   Use the commented `FILES` binding in `wrangler.jsonc` as the binding template.
3. Take a D1 backup and rehearse the additive migration locally before applying
   the registered migration sequence in the approved environment.
4. Add the private `FILES` binding and set `FILE_STORAGE=r2` in the approved
   deployment configuration. Start with `FILE_QUOTA_MB=450`. Review storage
   and operation costs before raising the quota. These settings use a Worker
   binding and need no runtime S3 credential.
5. Verify a small upload through the public form or a signed-in attachment,
   a second-device read, public share revocation and deletion recovery. Review
   local evidence before live activation.

New files become readable from D1 once all chunks are complete. In R2 mode the
Worker writes a verified copy, commits the location and drops the source chunks
in the same D1 transaction. Failed copies remain readable in D1 and retain a
recovery job. A permanent file deletion reservation lets the existing scheduled
retention phase clean up late objects.

## Backfill

Use the authenticated Workspace administrator API with a fresh session.
`POST /api/admin/files/migrate?dryRun=1` shows eligible readable files and
bytes for one page. Repeat with the returned numeric `after` cursor. Each page
examines at most five storage rows and may return fewer where access or the D1
budget limits it. The cursor addresses a storage row and does not disclose
the IDs of files outside the caller's access. Omit `dryRun` to copy and verify.
Continue until `next` is null. A second pass from the beginning is idempotent
and picks up rows created or retried during the first pass. Avoid database
compaction during a scan. Use the current authorized workspace scope to see a
page's results. Monitor `file_storage_jobs` for pending and repeated failures.

## Backup and restore

Quiesce uploads, backfill and file retention before taking a matched backup.
Keep the D1 export together with a copy of R2 objects from the same maintenance
window. Use the approved operator credentials with an R2-capable copy tool, such
as `rclone copy`, to a private backup destination. Keep the stable object keys
and verify against the D1 `r2_key`, `size` and `sha256` manifest. Protect the
backup as workspace data.

Restore both parts into disposable instances first. Recompute the SHA-256 of
restored bytes and confirm representative D1 and R2 attachments, including a
share that is allowed and one that is inaccessible. Keep email, push and paid
AI disabled during rehearsal. Local tests cover paired metadata and object
restoration and detect a missing object.

To stop new R2 copies, set `FILE_STORAGE=d1` and retain the `FILES` binding so
existing R2 files stay readable and deletions can finish. An earlier binary that
only reads D1 cannot serve migrated attachments. Use the R2-aware binary for
rollback of configuration, or restore a coordinated pre-activation backup with
the owner's release process.
