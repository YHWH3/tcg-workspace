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

## Architecture

- `shared/collections.ts` — the collection allowlist used by client Dexie tables and the worker push validator. Currently: `pages`, `blocks`, `tasks`, `comments`, `activity`, `boards`, `files`.
- `worker/` — Hono app: `auth.ts` (signup/login/sessions/me), `sync.ts` (`/api/sync/push|pull`), `files.ts` (chunked upload, byte serving, usage, Whisper transcribe), `admin.ts` (users + invites), `merge.ts` (pure per-field LWW), `index.ts`.
- `src/core/` — `db.ts` (Dexie: one table per synced collection + `blobs` (local file bytes) + `outbox` + `meta`), `hlc.ts`, `sync/engine.ts` (`mutate()` local-write API, push/pull loop, rebase on pull, `seedRecord()` built-in rows), `sync/rebase.ts` (pure), `files.ts` (`addFile`/`deleteFile`/`useFileUrl` + resumable chunk upload + transcription), `fileui.tsx` (attachment renderers), `recorder.tsx` (voice memos), `chunks.ts`, `auth.ts`, `theme.ts`, `shell.tsx`, `search.tsx` (⌘K), `install.tsx`, `settings.tsx`, `ui.tsx` (primitives).
- `src/modules/` — `pages/`, `boards/`, `comments/`, `activity/`. The shell builds nav + routes purely from `modules` in `src/modules/index.ts`.
- `src/sw.ts` — custom service worker (injectManifest): precache + SPA navigation fallback, `/api/*` never cached, `share_target` POST → `shared_inbox` idb → redirect `/capture?shared=1`. Must stay classic-script safe (`injectManifest.rollupFormat: 'iife'` in vite.config.ts).

## File pipeline

Attachments are `files` records found by `parentId` (`task` | `block` | `mooditem`) — never an array on the parent, so concurrent attaches can't clobber. `addFile(blob, {parentType, parentId, name?})` writes bytes to the local `blobs` table (`state: 'pending'`) and metadata via `mutate()` — fully offline. After each `pushOutbox` the engine calls `uploadPendingBlobs()`: chunked `PUT /api/files/:id/chunks/:idx` (1 MiB, resumable via `uploadedChunks`), `POST .../complete`, then `state: 'uploaded'`. 413/507 mark the blob `failed` + toast without jamming the queue; other errors retry next sync. Audio with `transcriptState: 'pending'` is transcribed after upload (Workers AI Whisper, `AI` binding); transient failures retry with `transcriptAttempts` capped at 5. `useFileUrl(id, preferThumbId?)` resolves Dexie blob → object URL, else fetches with bearer and caches. Images are recompressed ≤2048px webp (+480px thumb as its own file via `thumbId`). Limits: 20 MB/file, 450 MB workspace (`GET /api/files/usage`, bar in Settings).

## Boards

`boards` records hold `{name, icon, columns: {id,name,color}[], order}` — `columns` is a single LWW field (rare edits). `tasks.boardId` (missing → `board-default`), `tasks.status` = column id (unknown → first column; last column counts as "done"). `board-default` and `board-inbox` are seeded via `seedRecord()` (field ts=1 — any real edit wins). Drag/drop is @dnd-kit (mouse + touch long-press ~200ms); `/tasks` is "My tasks" across boards, `/tasks/:id` redirects to the board route.

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
