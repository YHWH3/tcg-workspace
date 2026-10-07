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

- `shared/collections.ts` — the collection allowlist used by client Dexie tables and the worker push validator. Currently: `pages`, `blocks`, `tasks`, `comments`, `activity`, `boards`, `files`, `moodboards`, `mooditems`. `shared/` also holds the pure logic both sides import: `fields.ts` (custom fields), `markdown.ts` (markdown⇄blocks + mention tokens), `templates.ts` (template instantiation planner), `order.ts` (fractional-index keys tolerant of malformed values), `filekinds.ts`.
- `worker/` — Hono app: `auth.ts` (signup/login/sessions/me), `sync.ts` (`/api/sync/push|pull`; after a successful push it calls `LIVE.poke()`), `files.ts` (chunked upload, byte serving, usage, Whisper transcribe), `admin.ts` (users + invites), `merge.ts` (pure per-field LWW), `live.ts` (`/api/live` WS upgrade → LiveRoom DO, auth via `ws-auth` subprotocol token), `shares.ts` (share-token CRUD), `public.ts` (unauthed `/api/public/*` router), `publicAccess.ts` (pure access decisions — unit-tested in `tests/publicAccess.test.ts`), `index.ts`.
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
- Activity attribution: MCP writes log `meta.via = clientName` — the Activity UI renders "via <client>".
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
- Deletes are soft: `mutate(c, id, { deleted: true })`.
- Cross-module features go through `slots` (`taskDetail`, `pageFooter`) — don't import one module from another.
- Log user-visible events via `logActivity(verb, targetType, targetId, targetTitle, meta?)` — but not per-keystroke edits.
- Env types: after editing `wrangler.jsonc` run `npm run cf-typegen`.
