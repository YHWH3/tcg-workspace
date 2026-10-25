# Phase 13 — Trust and polish

Branch `sol/p13-polish` stacked on `sol/p12-database-power`.

## 13.1 Record history diff view

- **Exists:** the `record_history` table (all write sources, before/after JSON,
  revision, actor, source, changeset id), `GET /api/history`
  (`worker/history.ts`), `src/core/History.tsx`, and MCP
  `get_record_history` / `restore_record_fields`.
- **Add:** a side-by-side or inline field diff for a selected revision.
  - Text fields use a word-level diff (pure `shared/textDiff.ts`, no
    dependency).
  - Block bodies show added, removed and changed blocks.
  - "Restore these fields" reuses the existing restore job with expected
    revision.
- **Redaction:** keep the existing rules (unreadable copies hidden).
- **Tests:** diff unit tests; browser on three engines.

## 13.2 Sync conflict viewer

- **Problem:** per-field last-writer-wins silently discards the losing value.
- **Client detection:** during rebase on pull (`src/core/sync/rebase.ts`), when
  a local pending field value is overwritten by a newer remote value for the
  same field, record a conflict entry in Dexie `meta` (`conflicts:<recordId>`)
  with `{field, mine, theirs, theirsBy, at}`. This needs a Dexie version bump
  only if it becomes a table; prefer `meta`. Cap 200 entries and prune after 14
  days.
- **UI:** a "Changes that didn't win" panel in the Reliability view (8.9) and a
  dot on the record. Actions: "Use mine" (re-applies via `mutate()`) or
  "Dismiss".
- **Honesty:** this covers only conflicts this device observed.
- **Tests:** unit with rebase fixtures; browser with two contexts editing the
  same field offline.

## 13.3 Group mentions

- **Groups:**
  - A server-only table `mention_groups(id, name, created_by, updated_at)` plus
    `mention_group_members(group_id, user_id)`. Admins manage them in
    Settings → Admin.
  - Alternatively, use spaces as groups (`@space:<id>`) to avoid a new table.
    Choose spaces if the owner agrees (D13); it is cheaper and
    permission-aligned.
- **Token:** `@[group:ID]` in `shared/markdown.ts`, `core/mentions.ts` and
  `resolveMentions`.
- **Notification:** a `mention` notification to each member who can read the
  target (read gate at enqueue), with a cap of 20 recipients.
- **Tests:** tokenizer, notification fan-out under the gate.

## 13.4 Share passwords (only if requested)

- **Migration:** `shares.password_hash`, `password_salt`.
- **Flow:**
  - The public page shows a password form.
  - `POST /api/public/:token/unlock` verifies with the existing
    `worker/password.ts` (PBKDF2), rate-limited per token and IP (`rate_limits`).
  - On success, set a signed, HttpOnly, SameSite=Strict cookie scoped to
    `/api/public/<token>`, valid for 12 h.
  - Subsequent requests check the cookie only (no PBKDF2 per view: CPU budget).
  - Rotation (9.7) invalidates cookies (include `rotated_at` in the signature).
- **Tests:** D1 brute-force throttling, cookie scope, rotation invalidation;
  browser.

## 13.5 Connector compatibility checks

- **Gemini (or any further MCP host):** run the existing external connector
  acceptance script against a local tunnel only with owner approval (tunnels
  are public). Otherwise document as NOT RUN.
- Update `docs/architecture/unified-ai-mcp.md` §7 with results.

## 13.6 Google sign-in (optional; only if the team grows)

- OAuth with Google as an additional login method mapped to existing accounts by
  verified email (10.1). The seat cap and invite rules are unchanged.
- **Requires the owner to:** create a Google Cloud OAuth client and set its
  secrets. Not before 10.1 exists.
