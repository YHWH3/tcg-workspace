# Phase 11 — Larger file storage (Cloudflare R2)

Branch `sol/p11-storage` stacked on `sol/p10-notifications`. Independent of
Phases 8–10 in function; stacked only for migration ordering.

**Owner prerequisite (D9):** create an R2 bucket (e.g. `tcg-workspace-files`)
and add the binding. Check the current R2 free-tier limits and whether the
account needs a payment method at that time; do not assume them. Sol prepares
the `wrangler.jsonc` binding as a commented block plus documentation, and tests
locally with Miniflare's R2.

## Current design (verified)

- Bytes live in D1 `file_chunks(file_id, idx, data BLOB)` at 1 MiB per chunk
  (the D1 row ceiling). Metadata lives in the `files` table plus a `files`
  record in `records`.
- Limits: 20 MB per file and a 450 MB quota (`worker/files.ts:68-69`). Usage is
  at `GET /api/files/usage`.
- Routes: `PUT /:id/chunks/:idx`, `POST /:id/complete`, `GET /:id`,
  `DELETE /:id`, `POST /:id/transcribe` (`worker/files.ts:138-332`).
- **Other readers of `file_chunks`:**
  - `worker/forms.ts` (public form uploads);
  - `worker/public.ts` (shared files);
  - `worker/reminders.ts` (retention and orphan cleanup);
  - `worker/remotefile.ts` (remote import).
- **Serving and reclamation:**
  - serving goes only through `servedFile()` / `servedFileHeaders()`;
  - soft-deleted files enqueue `file_deletions` through triggers (migration
    0011), and byte reclamation consumes that queue.

## Design: keep the upload protocol; change where completed bytes live

1. **Migration:**
   - `ALTER TABLE files ADD COLUMN storage TEXT NOT NULL DEFAULT 'd1' CHECK(storage IN ('d1','r2'));`
   - `ALTER TABLE files ADD COLUMN r2_key TEXT;`
   - `ALTER TABLE files ADD COLUMN sha256 TEXT;`
2. **One storage module** `worker/fileStore.ts`. It is the only code that
   touches `file_chunks` or R2:
   - `readBytes(env, fileRow): Promise<Uint8Array|null>`;
   - `finalize(env, fileId)`;
   - `deleteBytes(env, fileRow)`;
   - `usage(env)`.
   Refactor the five consumers listed above to call it. No behaviour change
   when `storage='d1'`.
3. **Uploads are unchanged.** Clients still upload 1 MiB chunks into
   `file_chunks`. This avoids R2 multipart's 5 MiB minimum part size and keeps
   resumable uploads and offline queues identical.
4. **Finalize** on `POST /:id/complete`. When `FILE_STORAGE='r2'` and the
   `FILES` binding exists:
   - concatenate the chunks (≤20 MB, within Worker memory) and compute SHA-256;
   - `FILES.put('files/<id>', bytes, {httpMetadata:{contentType:<sanitized type
     from servedFileHeaders logic, never the uploader's>}, customMetadata:{sha256}})`;
   - then, in one batch: set `storage='r2'`, `r2_key`, `sha256`; delete the
     chunks.
   - On R2 failure, keep `storage='d1'` (the file still works) and log
     `file_r2_finalize_failed`; a later sweep retries.
5. **Reads:** `GET /:id`, public files and transcription call `readBytes`.
   For `r2`, read from `FILES.get(key)`; on a missing object, fall back to D1
   chunks if they still exist; otherwise return 404 and log
   `file_bytes_missing`. Headers always come from `servedFile()`.
6. **Deletes and reclamation:** the existing `file_deletions` consumer calls
   `deleteBytes`, which deletes the R2 object (idempotent) and any remaining
   chunks.
7. **Backfill of existing files** via an admin, keyset-paged endpoint
   `POST /api/admin/files/migrate?after=<id>`:
   - at most 5 files per request, within budget;
   - for each `storage='d1'` complete file: copy to R2, verify by re-reading and
     comparing SHA-256, then flip storage and delete chunks in one batch;
   - it returns `next`; the owner repeats it until `next` is null;
   - it is idempotent;
   - a dry-run mode reports counts and bytes.
   - No cron phase, to keep the scheduler budget intact.
8. **Quota and limits:**
   - `FILE_QUOTA_MB` var (default 450; the owner raises it once R2 is live).
   - The per-file limit stays 20 MB. Finalize concatenates the chunks in Worker
     memory and reads them from D1, so larger files need a separate streaming or
     multipart design (listed in deferred.md); do not raise it in this phase.
   - Client limits come from `/api/files/usage`, so the UI shows the right
     numbers. Image recompression stays (≤2048 px webp).
   - **Verify** every client place that hard-codes 20 MB or 450 MB.
9. **Flags and preflight:** `FILE_STORAGE` (`d1` default). Preflight asserts
   `d1` unless the binding is declared; the rehearsal covers both.
10. **Backups:** R2 objects are not in the D1 export. Add to the release runbook
    an `rclone`/`wrangler r2 object` copy procedure (owner) and a restore test.

## Tests

- **Unit/D1 (Miniflare R2)** in `tests/phase11-storage-d1.test.ts`:
  - finalize to R2;
  - read back is byte-identical and served headers are unchanged (SVG
    sanitization path included);
  - R2 put failure → stays d1;
  - backfill with verification;
  - deletion removes the object;
  - public share serving only for files inside the share tree (existing rule);
  - forms upload path;
  - transcription read path;
  - binding-call budget.
- **Browser:** upload, view, delete and share flows on three engines with
  `FILE_STORAGE=r2` locally; offline upload resume unchanged.

## Out of scope

- Direct-to-R2 browser uploads (presigned URLs).
- Video transcoding.
- CDN caching of private files.
