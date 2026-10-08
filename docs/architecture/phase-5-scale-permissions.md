# Phase 5 — Search, permissions, guests, history, scale

Goal: fast search across everything; access control so collaborators, volunteers and partners can have accounts limited to what is shared with them; more seats; durable history.

**This phase changes the sync model and needs a design review before implementation.** Treat this doc as the proposal to review.

Apply [cross-platform responsive web architecture](cross-platform-responsive-web.md), particularly account ownership, offline revocation limits, search/cache recovery and multi-device tests. The following decisions must be re-detailed in this phase's existing permission/sync design review; no new permission schema or runtime changes are implemented by the platform review.

---

## 1. Server search

- D1 FTS5 virtual table (verify availability — if unavailable, fall back to a maintained `search_terms(record_id, term)` table with a `term` index, or `instr` scan; decide at build time): `search_fts(record_id UNINDEXED, collection UNINDEXED, space_id UNINDEXED, title, body)`.
- Maintained by the Phase 4 event pipeline on every applied change: pages (title), blocks (text → aggregated per page into the page row), records (title + text fields + body blocks), comments, files (name), mood items (text).
- `GET /api/search?q=&type=&database=` and MCP `search` use FTS with prefix matching, ranked, permission-filtered (§2), ≤50 results with snippets.
- Client ⌘K: local Dexie search for instant results + server results merged when online.
- Semantic search: Phase 6.

## 2. Permission model

### 2.1 Concepts
- **Space**: a top-level container (e.g. "Core", "Common Lab", "Parambu Habitat", "Partner: X"). Every page and database belongs to exactly one space (`spaceId`); every record/block/comment/file/link/mooditem inherits the space of its container (denormalised `spaceId` written server-side on every write).
- **Roles** per space: `owner, admin, editor, commenter, viewer`. Workspace roles: `owner` (founders), `admin`, `member`, `guest`.
- Guests see only spaces they are explicitly added to. Members see spaces marked `defaultAccess: 'members'`.

### 2.2 Storage
- D1 tables: `spaces(id, name, default_access, created_at)`, `space_members(space_id, user_id, role)`.
- `users.role` extends to `owner|admin|member|guest`; seat limits configurable (`MAX_USERS`, `MAX_GUESTS` env vars) — decide with owner.
- `records` gains column `space_id` (migration + backfill: all existing → "Core"). Index `(space_id, seq)`. `data.spaceId` is set only on space-owning containers (pages, boards, moodboards); children resolve it server-side via `worker/access.ts` `resolveSpace(collection, data)` on every write — blocks/comments/links inherit their parent's resolved space, never trust a client-supplied `spaceId` on child rows.

### 2.3 Sync changes (the hard part)
- **Pull**: `WHERE seq > ? AND space_id IN (<user's readable spaces>)`. Cursor stays global `seq` (gaps fine). Per-collection rules on top: `notifications` additionally filtered to `userId = me` (they contain per-user content); `space_members`-derived collections follow membership.
- **Access revoked / record moved out of a readable space**: server must tell the client to drop it. Add `tombstones` feed: on space change of a record or membership removal, emit per-user "evict" markers (`evictions(user_id, record_id, seq)`); pull returns `{records, evict: ids[]}`; client deletes those Dexie rows + local blobs.
- **Push**: validate per change: user's role on the record's (current or target) space ≥ editor (commenter may create comments only); moving a record between spaces requires editor on both. Rejected changes counted in `rejected` and returned per id so the client can revert local state (client: on rejection, re-pull that id).
- **Files**: `/api/files/:id` checks the file record's space.
- **Live pokes**: per-space rooms or include space ids in `changed` so clients only pull when relevant.
- **MCP**: every read/write goes through the same `canRead/canWrite(user, spaceId)` helpers (`worker/access.ts`, pure decisions unit-tested like `publicAccess.ts`).
- Mentions/backlinks/relations to items the user can't read render as "Restricted item".

### 2.4 UI
Space switcher in sidebar; space settings (members, roles, default access); "Share" on pages extends from public link to "Invite to space"; guest sign-up through invite codes scoped to a space.

## 3. History / audit
- Client pushes are not change-set recorded today. Add `record_history(record_id, seq, user_id, fields JSON (before/after of changed fields), created_at)` written in `applyChanges` for all sources (store only changed fields; prune text history >180 days to last N=50 versions per record).
- UI: "History" on page/record: list of changes with restore-field action (uses undo planner semantics).
- Permission changes and role changes logged to activity (`verb: 'permission_changed'`).

## 4. Storage and scale
- Large media: Google Drive links (decided). Optional later: R2 if enabled.
- Hard delete/purge (admin): `Trash` view; purge removes records (D1 rows), chunks, history after confirmation.
- D1 limits: monitor DB size (free plan cap — verify current limit) and row reads; add `/api/admin/usage`.
- Client: Dexie holds only readable spaces; lazy-load archived records (exclude from initial pull via `archived` flag + on-demand fetch endpoint).

## 5. Review checklist (before building)
- Seat model and pricing constraints for guests.
- Whether any data must be hidden from some core members (affects whether "Core" is one space).
- Performance of per-user pull filter with hundreds of guests.
- Offline edits by a user whose access was revoked while offline (server rejects; client shows "changes couldn't be saved — access removed").

## 6. Acceptance
Guests see and edit only what's shared; revoked access disappears after a device successfully reconciles permissions (disconnected cached access cannot be remotely wiped immediately); search is fast across all permitted content; every change has history.

## 7. Multi-device access, responsive search and Definition of Done (design-review inputs)

- Define session controls for same user on phone/tablet/desktop: active session list/device labels, current-device sign-out, revoke chosen/other sessions and reauthentication. Test multiple tabs sharing localStorage; old-tab sync, live socket and rendered content must stop or reconcile when account/session changes. Cross-device online session revocation goes through server validation, not a client-only display toggle.
- Build on Phase 1 protected pending-work logout. Shared-device sign-out offers clear local cache retention/clearing choice appropriate to privacy, accounts for drafts/outbox/pending bytes, and never silently destroys them. Any allowed recovery export is scoped to current user and permission policy. Retained work cannot upload under another account; cleared work requires explicit discard acknowledgement.
- Re-detail offline permission freshness/lease policy with owner: bounded permitted offline access versus guaranteed offline availability is a tradeoff. No instant revocation claim for disconnected browsers, screenshots/downloads or exports. Server rejects unauthorized writes regardless of cached permission, and revocation is processed before UI/search reuse on successful reconnect. Resume never displays restricted data just because a previous browser cache had it.
- Eviction feed must cover revoked membership, moved records and stale/rejoined devices/cursors. Clear revoked records, inherited blocks/comments/links, pending unauthorized operations, downloaded thumbnails/blobs, object URLs, mounted UI state and local/server search results. Existing API network-only rule remains. A stale eviction marker must not wrongly hide newly regranted data: detail snapshot/reset/rejoin behavior before implementation.
- Rejected offline edits are not retried forever and must not use current app's unconditional successful-HTTP queue deletion as recovery. Show per-item reason, target and allowed recover/discard outcome. Whether text export is permitted after revocation, and whether drafts are held only transiently or quarantined, is an explicit privacy decision; never retain hidden restricted data indefinitely to enable recovery.
- Mobile search uses full-screen keyboard-aware field/results with type/database/space filters and snippets, accessible pagination/virtualization, clear local vs server results/loading/offline state. Merge/dedupe only authorized results. Restricted backlinks/relations use neutral Restricted item labels; no title/snippet/thumbnail leaks. History/restore has compact field before/after and server-checked revisions/permissions.
- Guest invite/auth/space switch/settings works at 320px, software keyboard and screen reader. Read-only/commenter/editor capability labels and error reasons consistent in every mode; installed PWA and normal tabs reconcile identical rights. Cache budgets/lazy archives preserve unsynced allowed work and explain uncached offline targets.

Definition of Done: review approves session/offline-freshness/retention choices before build. Test same user on physical phone + desktop and independent engine contexts, two guest roles, revoke while offline, rejected push, space move, regrant after stale cursor, remote logout and account B login while A has pending bytes/old tab open. Reconnect removes unauthorized data from every listed cache/render/search path before reuse; cached offline behavior matches documented lease limits. Compact search/history/guest CRUD rights pass Chromium/Firefox/WebKit and real Safari/Android plus keyboard/VoiceOver/TalkBack/NVDA. Report disconnected-device and already-exported-data limits explicitly; no remote-wipe promise.
