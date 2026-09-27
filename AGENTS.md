# Workspace — agent guide

Local-first mini-Notion: Vite + React + TS client, Hono Worker API, D1, Dexie outbox + per-field LWW sync.

## Commands

- `npm run dev` — vite dev server (client + Worker + local D1 via @cloudflare/vite-plugin) on http://localhost:5173
- `npm run db:migrate:local` — apply `migrations/*.sql` to local D1 (`.wrangler/state`)
- `npm run build` — type-aware client+worker build to `dist/` (client assets + worker)
- `npm test` — vitest (merge, rebase, password tests in `tests/`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run icons` — regenerate `public/icons/*.png` from the SVG monogram (sharp)
- `npm run smoke` — `scripts/smoke.sh` end-to-end API test against the dev server (bootstrap → invites → 7-seat cap → push/pull/merge → auth rejects)
- `node scripts/screenshots.mjs` — playwright visual pass → `/tmp/notion-shots/`
- `node scripts/offline-test.mjs` — offline create/reload/resync test (needs `wrangler dev --port 8788` running the built app)

## Architecture

- `shared/collections.ts` — the collection allowlist used by client Dexie tables and the worker push validator.
- `worker/` — Hono app: `auth.ts` (signup/login/sessions/me), `sync.ts` (`/api/sync/push|pull`), `admin.ts` (users + invites), `merge.ts` (pure per-field LWW), `index.ts`.
- `src/core/` — `db.ts` (Dexie: one table per collection + `outbox` + `meta`), `hlc.ts`, `sync/engine.ts` (`mutate()` local-write API, push/pull loop, rebase on pull), `sync/rebase.ts` (pure), `auth.ts`, `theme.ts`, `shell.tsx`, `search.tsx` (⌘K), `install.tsx` (PWA install + iOS hint), `settings.tsx`, `ui.tsx` (primitives).
- `src/modules/` — `pages/`, `tasks/`, `comments/`, `activity/`. The shell builds nav + routes purely from `modules` in `src/modules/index.ts`.

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
