# Workspace — agent guide

Local-first mini-Notion: Vite + React + TS client, Hono Worker API, D1, Dexie outbox + per-field LWW sync.

## Commands

- `npm run dev` — vite dev server (client + Worker + local D1 via @cloudflare/vite-plugin) on http://localhost:5173
- `npm run db:migrate:local` — apply `migrations/*.sql` to local D1 (`.wrangler/state`)
- `npm run build` — type-aware client+worker build to `dist/` (client assets + worker)
- `npm test` — vitest (merge, rebase, password tests in `tests/`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run icons` — regenerate `public/icons/*.png` from the SVG monogram (sharp)
- `npm run smoke` — `scripts/smoke.sh` end-to-end API test against the dev server (bootstrap → invites → 7-seat cap → push/pull/merge → chunked file upload roundtrip → auth rejects)
- `node scripts/screenshots.mjs` — playwright visual pass → `/tmp/notion-shots/`
- `node scripts/offline-test.mjs` — offline create/reload/resync test (needs `wrangler dev --port 8788` running the built app)
- `node scripts/verify-v3.mjs` — full boards/media/capture e2e (needs `wrangler dev --port 8788` running the built app + `admin`/`bob` users from smoke)
- `node scripts/verify-v4.mjs` — presence/instant-sync, moodboard gestures, block comments, public links e2e (same :8788 requirements; `vite dev` does NOT forward WS upgrades — run against `wrangler dev`)

## Architecture

Roadmap and build specs for upcoming phases live in `docs/architecture/` (start with `README.md`; Phase 0 and 1 are implementation-ready).

- Before implementing a feature, read `docs/architecture/cross-platform-responsive-web.md` and the relevant phase. One responsive HTTPS application, optional PWA installation, full mobile functional parity and WCAG 2.2 AA are permanent requirements. Use existing core primitives/modules and `mutate()`/`applyChanges()` paths; no separate platform codebases.
- Verify delivered workflows across compact/tablet/desktop layouts, keyboard/touch, Playwright Chromium/Firefox/WebKit and the applicable real-device checks in that specification. Emulated WebKit is not real iOS Safari. Report exact checks and missing gates; desktop Chromium alone is insufficient. Keep local-save/server-sync/media states distinct and provide capability/recovery fallbacks. The Phase 0 §0.1 security fix remains first and may ship independently of platform retrofits.

- `shared/collections.ts` — the collection allowlist used by client Dexie tables and the worker push validator. Currently: `pages`, `blocks`, `tasks`, `comments`, `activity`, `boards`, `files`, `moodboards`, `mooditems`, `views`, `links`. `shared/` also holds the pure logic both sides import: `fields.ts` (custom fields), `markdown.ts` (markdown⇄blocks + mention tokens), `templates.ts` (template instantiation planner), `order.ts` (fractional-index keys tolerant of malformed values), `filekinds.ts`, `views.ts` (view filter/sort/groupBy eval — FieldKey `p_<fid>`/`rel_<fid>`/builtins), `tree.ts` (sub-record hierarchy, max depth 3), `deps.ts` (dependency cycle checks), `linkid.ts` (deterministic link ids), `drive.ts` (Google Drive URL parsing).
- `worker/` — Hono app (see also `ratelimit.ts` throttles + grant revocation, `closure.ts` subtree reads, `templateSnapshot.ts` template closure): `auth.ts` (signup/login/sessions/me), `sync.ts` (`/api/sync/push|pull`; after a successful push it calls `LIVE.poke()`), `files.ts` (chunked upload, byte serving, usage, Whisper transcribe), `admin.ts` (users + invites), `merge.ts` (pure per-field LWW), `live.ts` (`/api/live` WS upgrade → LiveRoom DO, auth via `ws-auth` subprotocol token), `shares.ts` (share-token CRUD), `public.ts` (unauthed `/api/public/*` router), `publicAccess.ts` (pure access decisions — unit-tested in `tests/publicAccess.test.ts`), `index.ts`.
- `src/core/` — `db.ts` (Dexie: one table per synced collection + `blobs` (local file bytes) + `outbox` + `meta`), `hlc.ts`, `sync/engine.ts` (`mutate()` local-write API, push/pull loop, rebase on pull, `seedRecord()` built-in rows), `sync/rebase.ts` (pure), `files.ts` (`addFile`/`deleteFile`/`useFileUrl` + resumable chunk upload + transcription), `fileui.tsx` (attachment renderers), `recorder.tsx` (voice memos), `chunks.ts`, `auth.ts`, `theme.ts`, `shell.tsx`, `search.tsx` (⌘K), `install.tsx`, `settings.tsx`, `ui.tsx` (primitives), `mobile.ts` (`useIsMobile` — keep it here, NOT in `shell.tsx`, to avoid module↔core import cycles), `live.ts` (WS client: `here` on route change, 30s heartbeat, `changed` → `syncNow`, jittered reconnect, disconnects when hidden >60s), `presence.tsx` (`PresenceStack`, `usePresence`), `mentions.ts` (pure token serializer/DOM-offset helpers), `resolveMentions.ts` (token → live title/name resolution), `commentui.ts` (comment-target store shared by modules).
- `src/modules/` — `pages/` (incl. `RichInput` contentEditable + mention chips, `Backlinks`, `Share` popover), `boards/`, `comments/` (IG-style threads on tasks/pages/blocks/mooditems via the `commentBadge` slot), `activity/`, `moodboards/` (infinite canvas, palette extraction, convert-to-task). The shell builds nav + routes purely from `modules` in `src/modules/index.ts`.
- `src/public/PublicView.tsx` — read-only shared-page renderer for `/s/:token[/:pageId]`, mounted in `App.tsx` OUTSIDE the auth shell: never starts the sync engine, never redirects to login, sets `noindex`.
- `src/sw.ts` — custom service worker (injectManifest): precache + SPA navigation fallback, `/api/*` never cached, `share_target` POST → `shared_inbox` idb → redirect `/capture?shared=1`. Must stay classic-script safe (`injectManifest.rollupFormat: 'iife'` in vite.config.ts).

## File pipeline

Attachments are `files` records found by `parentId` (`task` | `block` | `mooditem`) — never an array on the parent, so concurrent attaches can't clobber. `addFile(blob, {parentType, parentId, name?})` writes bytes to the local `blobs` table (`state: 'pending'`) and metadata via `mutate()` — fully offline. After each `pushOutbox` the engine calls `uploadPendingBlobs()`: chunked `PUT /api/files/:id/chunks/:idx` (1 MiB, resumable via `uploadedChunks`), `POST .../complete`, then `state: 'uploaded'`. 413/507 mark the blob `failed` + toast without jamming the queue; other errors retry next sync. Audio with `transcriptState: 'pending'` is transcribed after upload (Workers AI Whisper, `AI` binding); transient failures retry with `transcriptAttempts` capped at 5. `useFileUrl(id, preferThumbId?)` resolves Dexie blob → object URL, else fetches with bearer and caches. Images are recompressed ≤2048px webp (+480px thumb as its own file via `thumbId`). Limits: 20 MB/file, 450 MB workspace (`GET /api/files/usage`, bar in Settings).

## Boards

`boards` records hold `{name, icon, columns: {id,name,color}[], fields: FieldDef[], order}` — `columns` and `fields` are single LWW fields (rare edits). `tasks.boardId` (missing → `board-default`), `tasks.status` = column id (unknown → first column; last column counts as "done"). `board-default` and `board-inbox` are seeded via `seedRecord()` (field ts=1 — any real edit wins). Drag/drop is @dnd-kit (mouse + touch long-press ~200ms); `/tasks` is "My tasks" across boards, `/tasks/:id` redirects to the board route.

### Custom fields

`FieldDef` + pure helpers (`fieldsOf`, `propKey`, `coerceFieldValue`, `formatFieldValue`, `optionByName`, `isSelectType`) live in `shared/fields.ts` — the ONE source for worker (MCP) + client (`src/modules/boards/model.ts` re-exports it). Task values are top-level `p_<fieldId>` keys (never a nested object) so concurrent edits merge per-field. Values: string for text/url/date(yyyy-mm-dd), number, boolean, option id, option id[], user id. Removed fields leave stale keys — ignored. UI: `FieldsEditor.tsx` (board menu → "Fields" sheet), `FieldValue.tsx` (`FieldRow` inline editors in task detail, `FieldChips` on cards for `showOnCard`, `useFieldFilterOptions` for the board filter). MCP writes can add unknown select options by name (auto-append to `fields`).

### Databases, views & links (Phase 1)

Boards are general-purpose **databases**: `kind: 'tasks' | 'records'`, `recordNoun`, `description`, `showBuiltins` (hides assignee/due/priority on records dbs), `defaultViewId`. `views` rows hold named configs `{filters, sorts, groupBy, visible, cover, mine, showSubrecords}` with `databaseId` + `type: table|list|gallery|board`. Filter/sort `key` is a FieldKey: builtins or `p_<fieldId>` for custom fields / `rel_<fieldId>` for relation fields.

Custom field values live on records as `p_<fieldId>`; **relation** values live only in the `links` collection (`kind:'relation'`, `fieldId`, `fromId`/`toId`; reverse pairs auto-written for two-way fields, `single` clamps to one, deterministic `linkId` id). `kind:'related'` is see-also; `kind:'blocks'` is dependencies. Records nest via `parentId` (same database, max depth 3, cycle-checked); delete cascades `deletedVia` to descendants and restore brings them back. Every record has a page body = `blocks` rows with `pageId = <recordId>` (edit via `edit_record_body`).

Block type `embed` + `parseLinkUrl` in `shared/drive.ts` renders Google Drive files/folders (desktop iframe / mobile card); file attachments accept `kind:'link'` that never uploads.

**Add a view type**: extend `VIEW_TYPES` in `shared/views.ts` → render branch in the database view switch (`src/modules/boards/`) → accept it in `add_view`/`update_view` → cover in `views.test.ts` + `verify-mcp-phase1.mjs`.

**Add a bundled template**: author via the template page UI or hand-write `templates/<key>.json` (`{key,name,description,icon,root,snapshot:{pages,blocks,boards,tasks,views,links}}` — `scripts/export-template.mjs <pageId>` dumps one from local D1), register it in `src/core/bundledTemplates.ts`. The Settings → Template gallery installs it via `instantiateTemplate(root,{snapshot,templateKey:key})`; the planner remaps every id (relation targets, parentId, links, `@[rec:]`/`@[page:]` mentions).

### Page templates

`pages.isTemplate` marks a page as a template (menu toggle, subtle icon in tree, "+" → template picker). `shared/templates.ts` `planTemplateInstantiation(snapshot, opts, {id, now})` is a pure planner returning `{rootPageId, writes}` — deep-copies the page/block subtree with new ids + fresh order keys, substitutes `{{name}}` placeholders (unknowns kept), copies each embedded `tasks` block's board (columns+fields+live tasks, assignee/due dropped), keeps `fileId` references. The client applies writes via `mutate()` (`instantiateTemplate` in `pages/api.ts`); MCP `create_from_template` applies them via `applyChanges`.

## Mentions & live

- Block text stores `@[page:ID]` / `@[user:ID]` tokens; `RichInput` renders them as `contenteditable=false` chips and resolves titles/names live (`resolveMentions`). All DOM↔text mapping lives in `core/mentions.ts` (pure, unit-tested). New user-mention tokens on commit log `mentioned` activity (`meta.userId`).
- `GET /api/live` upgrades to a `LiveRoom` Durable Object (SQLite class via `new_sqlite_classes` in `wrangler.jsonc`, hibernation API). Auth: `new WebSocket(url, ['ws-auth', token])` — the worker validates the session before forwarding; no tokens in URLs. Push → `poke()` → `{t:'changed'}` broadcast → clients `syncNow()`. `presence.tsx` renders `PresenceStack` (add it to page/board/moodboard/task-detail headers) and sidebar dots.

## Public shares

`shares` table (migration `0003`) maps token → page. `POST /api/shares` is idempotent per page. Public reads go through `worker/public.ts`; ALL access decisions funnel through `worker/publicAccess.ts` (`canServePage`, `canServeFile` — pure, unit-tested; uses `json_extract` on `records`). Files are only served when referenced inside the shared tree (block `fileId`/thumb, or a shown task's `coverFileId`).

## MCP server (AI connectors)

`/mcp` is a stateless Streamable-HTTP MCP endpoint on the same Worker, wrapped by `@cloudflare/workers-oauth-provider` in `worker/index.ts`:

- OAuth 2.1 + PKCE + DCR: provider serves `/oauth/authorize` (endpoint *declaration* — our `worker/oauth.ts` route renders the consent form), `/token`, `/register`, and `/.well-known/oauth-*` metadata. `resourceMetadata.resource` is derived per-request from the URL origin so local/staging/prod all validate correctly.
- Consent page (light/dark, CSP-free inline CSS): `parseAuthRequest` → `describeConsent` → `beginConsent` (browser cookie + one-time `handle` form field) → POST verifies workspace creds with `verifyPassword` → `approveConsent` → `completeAuthorization` with `props: {userId, clientName}`. Never trust a form-supplied identity.
- `mcpApiHandler` (`worker/mcp.ts`): per request, rejects if `props.userId` is gone (deleted user → 401), builds a fresh `McpServer` from `@modelcontextprotocol/server` via `agents/mcp/server` `createMcpHandler({route:'/mcp'})`, per-request Ctx holds lookup caches (never module state).
- Writes go through `applyChanges(env, userId, changes, {serverTs:true})` in `worker/sync.ts` — same merge/upsert as `/api/sync/push`, but stamps `ts = max(now, max(field_ts)+1)` so server edits win; then `pokeLive()` so open UIs refresh. Max 500 records per tool call.
- Markdown⇄blocks is `shared/markdown.ts` (`markdownToBlocks`, `blocksToMarkdown` — accepts `[[Page Title]]`/`@handle` resolved to `@[page:id]`/`@[user:id]` tokens; renders tokens back). Remote image/file URLs import via `worker/remotefile.ts` (https only, ≤20 MB, same chunk tables + `files` record as client uploads).
- Write safety (Phase 1): every mutating tool is wrapped by `reg()` (`worker/mcp.ts`) —
  - **Revisions/conflicts**: `records.seq` is the row revision; write tools take `expectedRev` (the seq the caller read) and fail with a `WriteConflict` §4.3 error JSON when the stored seq differs — callers re-read and retry.
  - **`requestId`**: optional idempotency key (1–64 chars). Re-sending the same requestId returns the stored result without re-applying the write.
  - **`dryRun`**: `dryRun:true` returns the impact preview (rows that would be created/changed) without writing.
  - **Change sets/undo**: each write call opens a changeset (`beginChangeset`/`commitChangeset` in `worker/changesets.ts`), recorded per-field for undo; results include `changesetId`. `GET /api/changes?mine=1` lists the last sets; `POST /api/changes/:id/undo` restores prior values (409 already-undone, 404 unknown). Activity entries carrying `meta.changesetId` show an Undo button; Settings → "Recent AI changes" lists the last 20 with Undo.
- Activity attribution: MCP writes log `meta.via = clientName` and `meta.changesetId` — the Activity UI renders "via <client>", the "AI changes" filter chip selects them, and `meta.changesetId` rows offer Undo.
- Grants: `GET/DELETE /api/oauth/grants[/:id]` (session auth) back the Settings → AI connectors list + Revoke.
- Tool returns concise JSON text including the app URL of what was created (`/pages/:id`, `/boards/:id[/tasks/:id]`, `/moodboards/:id`, `/s/:token`).

### Add an MCP tool

In `createWorkspaceServer` (`worker/mcp.ts`): `server.registerTool(name, { description, inputSchema: z.object(...), annotations }, async (args) => { ...; return txt(result) })`. Read via `recs()`/`rec()`; write via `write(env, ctx, userId, ops)` + `activityOp()`. Use `fillCaches(ctx)` then `ctx.userByKey`/`ctx.pageIdByTitle` for name→id lookup. Keep writes ≤500 records and prefer the `create_project` shape for bulk imports.

## Add a block type

1. Create a renderer `({block, onNewBelow, onDelete}) => JSX`.
2. `registerBlockType('mytype', 'Slash menu label', Renderer)` — see `src/modules/pages/blocks/registry.ts`; `pages/blocks/media.tsx` registers `image`/`video`/`audio`/`file`, boards registers `tasks`.
3. Add the block's fields to the block type in `shared/types.ts` if new (e.g. `fileId`, `caption`, `boardId`).

## Add a module

1. Create `src/modules/<name>/` with an `AppModule` object: `id`, `label`, `icon`, `navItem`, `routes`, `collections`, optional `sidebarSection` / `navBadge` / `slots`.
2. Export it and add it to `modules` in `src/modules/index.ts`.
3. If it needs a new collection: add the name to `COLLECTIONS` in `shared/collections.ts` and a matching table (with indexes) in `src/core/db.ts` — bump the Dexie version. No SQL migration needed (records are generic).

## Remove a module

Delete its entry from `modules` in `src/modules/index.ts` — nav, routes, sidebar section and any slot contributions (e.g. comments inside task detail / page footer) disappear with no other code changes.

## Conventions

- Writes always go through `mutate(collection, id, patch)` — never `table.put` directly (keeps outbox + field timestamps correct).
- No module-level mutable state in `worker/` — requests interleave in one isolate; caches that bind request scope (env, ExecutionContext, identity props) must be built per request (the MCP handler is constructed inside `mcpApiHandler.fetch` for exactly this reason).
- Deletes are soft: `mutate(c, id, { deleted: true })`.
- Cross-module features go through `slots` (`taskDetail`, `pageFooter`) — don't import one module from another.
- Log user-visible events via `logActivity(verb, targetType, targetId, targetTitle, meta?)` — but not per-keystroke edits.
- Env types: after editing `wrangler.jsonc` run `npm run cf-typegen`.

## Cross-phase invariants (from the 2026-10 audit — see `docs/reviews/cross-phase-audit.md`)

- **Server-only tables, not collections.** `notifications`, `approvals`, `form_tokens`, `form_submissions`, `website_ingest`, `rate_limits`, `event_outbox`, `date_index`, `reminder_sent`, `automation_runs`, `changesets`/`changeset_items`, `undo_*`, `mcp_requests`, `mcp_write_jobs`, `search_documents`/`search_fts`/`search_dirty` are D1 tables read through authenticated endpoints. Never add them to `COLLECTIONS`.
- **Client input is untrusted.** Timestamps are bounded (`shared/clock.ts`: server clamps to now+60 s, client refuses to observe larger); record size is bounded (`record_too_large`); a MIME string, SVG bytes and `kind` are attacker-chosen.
- **One serving policy.** Stored files are served only through `servedFile()`/`servedFileHeaders()` (`worker/files.ts`); object URLs are created only through `renderableBlob()` (`src/core/renderable.ts`). Never emit an uploader-supplied `Content-Type`.
- **A policy refusal is item-wise.** Anything that can reject a write must be a pre-check in `applyChanges` returning a `rejectedItems` reason; a SQL guard that aborts the batch is only a race backstop (`gateTransition` is the single gate predicate).
- **Constant binding calls.** Every request/cron phase has a ~45-call D1 budget (`withD1Budget`). Use `db.batch`, `json_each(?)` and recursive CTEs (`worker/closure.ts`, `worker/templateSnapshot.ts`); never one call per record/page.
- **No whole-collection reads for exact answers.** `listCollection` is capped at 5,000 rows with no order and logs `collection_read_truncated`; use `listBy`, `listLinksByKind`, `listLinksTouching`, `pageClosure`.
- **Soft delete is reversible.** Cascades mark `deletedVia: <root id>`; `restore_item` revives exactly those rows; attachments are never tombstoned by a parent delete (byte reclamation, migration 0011, is irreversible).
- **Credentials derive grants.** Password change and user removal call `revokeAllGrants()` (so must a future "disable account" path — nothing sets `users.disabled_at` yet; MCP requests already refuse a disabled user per request). Live sockets carry the session hash and the sweep closes them when the session row is gone, expired or its user is disabled — the same definition of "live session" as `userByToken`.
- **One timestamp ordering.** `applyChanges` heals stored timestamps in place *before* `authorizeMutations`, so the authorizer's "which fields does this change touch" is decided on the same ordering the merge applies (`tests/phase5-audit-interplay-d1.test.ts`). Anything new that reads `field_ts` ahead of the merge must read the healed rows.
- **Reads go through the read gate.** User-visible reads use the request's gated environment (`withReadGate` in `worker/readAccess.ts`): the `records.ts` helpers, `pageClosure` and `loadTemplateSnapshot` filter through the kernel graph + current memberships after loading, with a revision check; unauthorized ≡ missing. MCP builds it in `createWorkspaceServer`; integrity reads that never reach the caller use `serviceEnv(env)`. Search is `worker/search.ts` (`searchRecords` for MCP `search` and `GET /api/search`; triggers mark documents dirty in the same statement as every record write, the processor rebuilds ≤50 per chunk, dirty docs are matched live, rank uses only the document's own content, keyset cursors). `workspace_overview` and unsorted `query_records` page through `scanCollection` with explicit cursors. MCP never reads whole collections to resolve titles: `loadTitleKeys`/`loadTitleIds`/`prefetchMarkdown` fetch exactly the keys and ids a call names (`tests/phase5-reads-scale-d1.test.ts` pins flat binding-call costs). Public shares are pinned to their root's space (`worker/shareAccess.ts`, migration 0021); history/notifications/approvals redact copies of unreadable records. Inventory and remaining blockers: `docs/reviews/phase-5-authorized-reads.md`.

- **Permission sync is protocol 3.** Import `PERMISSION_PROTOCOL` from `shared/protocol.ts`. Server pull uses per-space feeds; materialized snapshots/global generation invalidation are retired. Client cache transactions compare `FeedState.version`; stage all joining scans and activate them as one group. Explicitly defer unscanned joins. A link's peer audience matters for eviction, and arbitrary dangling-link sweeps can erase links whose endpoints arrive later. Eviction triggers must deduplicate with `NOT EXISTS` under records UPSERT (migrations 0019–0020). Permissions remain disabled until every read surface and feature is complete and independently accepted.

## Phase 5 completion invariants

- Current runtime contract: `docs/architecture/phase-5-implementation.md` current section. Older Protocol 2/snapshot notes are historical. Keep permissions off outside disposable fixtures.
- `guest_invites`, `record_history`, `history_restore_jobs` are server-only D1 tables, never synced collections. Invitation secrets are hashed, one-use and issuer/session fenced; seven-account cap includes guests.
- Guest identity listings are self-only. Sticky `spaces.guest_directory_restricted` is enforced in both canonical kernels; People-containing spaces cannot be granted to guests. Do not clear the restriction without reviewed owner policy.
- History deltas commit in the record CAS transaction; restore uses current rights and expected revision. Protected ownership/deletedVia cannot be restored through ordinary field history. Preserve existing scoped cascade restore and durable undo.
- Notification delivery fences current target/recipient authority before caller checkpoints; read-time privacy and hidden unread counts remain required after delivery. Retained historical copies are not automatically purged.
- Search FTS/document changes all require the claimed dirty token. Local/remote palette responses are account/token/access-version bound. Cache metadata is Dexie v9; bounded LRU eviction must never remove original pending/uploaded bytes or pending outbox work.
- `npm run certify:phase5` uses the existing orchestrator; complete mode requires clean starting/ending source and all previous gates plus Phase 5 workflows. Never certify enabled permissions using disabled-mode evidence alone.

## Phase 6 invariants

- `ai_connections`, `ai_scope_consents`, `ai_previews`, `ai_preview_done`, `ai_workflow_changesets`, `ai_usage`, `ai_embedding_dirty`, `ai_embeddings`, `ai_suggestions`, `ai_digest_runs` are server-only, never synced collections.
- Connector authority intersects current canonical membership with the durable approved-space list. Do not copy a grant's old scopes into an authorization decision. Scope increases need reauthorization.
- Significant MCP writes need a frozen preview and genuine session-authenticated browser approval. MCP cannot approve itself. Retained request identity, expected revisions, source dependencies, capability fences, leases and atomic per-record checkpoints must survive retries and undo.
- AI providers are off by default. Do not invoke paid/real models during local certification. Distinguish simulated provider-contract tests from real-provider proof. Suggestions remain non-authoritative until human acceptance.
- Remote import is denied to arbitrary MCP URLs; never bypass explicit human consent and the exact trusted-host policy. Do not follow redirects or put workspace text in external requests.
- `npm run certify:phase6` extends the existing local orchestrator. Keep all earlier gates, explicit permission modes and clean-source fingerprint requirements.
