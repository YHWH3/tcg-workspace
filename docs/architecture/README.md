# Workspace → TCG operating system: architecture

> **Status 2026-10-15.** Phases 0–4 are merged on `main` and certified locally. Phase 5 is a draft foundation in PR #7 (not enabled); see [phase-5-design-review.md](phase-5-design-review.md). Phase 6 is a plan: [phase-6-implementation.md](phase-6-implementation.md). The cross-phase audit and its findings register are in [../reviews/cross-phase-audit.md](../reviews/cross-phase-audit.md).

These documents are the build spec for evolving the existing Workspace app into the organisational operating layer for The Common Ground (TCG). They are written for an implementation model: follow them phase by phase, in order.

**Permanent product requirement:** one fully responsive, browser-first HTTPS application on Windows, macOS, iPhone, iPad, Android phones/tablets and other capable browsers. Installation is optional. Mobile must support all operations delivered by a phase through appropriate touch/keyboard alternatives. Read [Cross-platform responsive web architecture](cross-platform-responsive-web.md) alongside every phase: it contains the source review, browser/capability contract, responsive interaction model, phase-impact matrix and reproducible verification strategy. It is a cross-cutting specification, not an eighth phase or evidence that compatibility has already been implemented.

| Doc | Scope | Detail level |
|---|---|---|
| [phase-0-safe-ai-editing.md](phase-0-safe-ai-editing.md) | MCP identity fix, revisions/conflicts, idempotency, change sets + undo, dry-run, targeted reads | **Implementation-ready** |
| [phase-1-databases-linking.md](phase-1-databases-linking.md) | Boards → databases, views (board/table/list/gallery), record pages, links + relations, sub-tasks, dependencies, People/Orgs starter, Google Drive links | **Implementation-ready** |
| [phase-2-visual.md](phase-2-visual.md) | Canvas v2 (task/page cards, frames, connectors, shapes, SVG, diagrams), calendar + timeline views, MCP canvas tools, optional in-chat app | Architecture + interfaces |
| [phase-3-tcg-pack.md](phase-3-tcg-pack.md) | TCG databases/templates pack, dashboard blocks, field mode, project review | Architecture + interfaces |
| [phase-4-rhythm.md](phase-4-rhythm.md) | Server event pipeline, notifications, reminders, recurrence, public forms, approvals, automations | Architecture + interfaces |
| [phase-5-scale-permissions.md](phase-5-scale-permissions.md) | Server search, permissions/spaces + filtered sync, guests, seats, audit history | Architecture; **needs design review before build** |
| [phase-6-ai.md](phase-6-ai.md) | AI-assisted workflows through MCP prompts, digests, semantic search | Architecture |

Before starting any phase: read `AGENTS.md` (repo root), this file, and the phase doc. Re-detail phases 2–6 into the Phase 0/1 level (exact schemas, files, tests) immediately before building them, against the code as it then exists.

Also read the platform specification. Its Phase 0/1 additions are implementation acceptance requirements; its Phase 2–6 additions remain architecture-level and must be re-detailed with those phases. No phase may defer its mobile workflows to a later responsive redesign. Keep the independent Phase 0 §0.1 identity security fix first; its isolated release does not wait for unrelated platform work. Shared non-canvas foundations complete with Phase 1, canvas foundations with Phase 2; new/touched Phase 0 surfaces already follow the platform contract.

---

## 1. Decisions already made (by the owner)

- Build order: **Phase 0 + Phase 1 first.**
- People beyond the 7 accounts participate through **public forms and read-only share links** for now; guest accounts are Phase 5.
- Large media lives in **Google Drive**; the app stores links + previews. The 20 MB / 450 MB D1 file store stays for photos, voice memos and small files.
- Keep the product generic: TCG-specific structure is **configuration (templates/databases)**, never hardcoded modules.
- Free infrastructure (Cloudflare Workers, D1, KV, Durable Objects, Workers AI).
- Browser-first, one responsive codebase, mobile functional parity and optional PWA installation. Capability detection and progressive enhancement replace native-app dependencies; retain the existing stack and phase order.

## 2. Current system (baseline, as of commit `76222f3`)

- **Client**: Vite + React 19 + TS, Tailwind v4, Dexie (IndexedDB) local store, PWA with custom service worker. Modules in `src/modules/*` registered in `src/modules/index.ts`; cross-module UI via slots (`src/modules/types.ts`).
- **Server**: one Cloudflare Worker (`worker/index.ts`): Hono app wrapped by `@cloudflare/workers-oauth-provider`. D1 `DB`, KV `OAUTH_KV`, Durable Object `LiveRoom` (presence + "changed" pokes), Workers AI (Whisper).
- **Data**: every synced entity is a row in the generic D1 table `records(id, collection, data JSON, field_ts JSON, seq, updated_by, updated_at)`. Collections allowlisted in `shared/collections.ts`: `pages, blocks, tasks, comments, activity, boards, files, moodboards, mooditems`.
- **Sync**: client `mutate()` writes Dexie + outbox in one transaction; push/pull via `/api/sync/*`; per-field last-writer-wins by HLC timestamp (`worker/merge.ts`); server compare-and-swap on `seq` (`worker/sync.ts` `applyChanges`). Every device pulls **all** records.
- **MCP**: `/mcp` stateless Streamable HTTP (`worker/mcp.ts`), OAuth 2.1 + PKCE + DCR, 23 tools, 3 prompts. Writes through `applyChanges(..., {serverTs:true})` + `pokeLive`.
- **Auth**: max 7 users, admin/member, invite codes, PBKDF2, bearer sessions.

## 3. Architectural principles (apply to every phase)

1. **Generic records first.** New entity kinds are new collections in the generic `records` table unless they need server-only secrecy, binary data, uniqueness constraints, or heavy querying — then a dedicated D1 table.
2. **Merge-safe shapes.** Anything two people may change concurrently must not be one array/object field. Model it as separate records (like `files` by `parentId`, `links`, `views`) or as top-level scalar keys (like `p_<fieldId>`). Rarely-edited config arrays (`columns`, `fields`) may stay single fields but must only be changed server-side via compare-and-swap ops (Phase 0 §4.3) or client UI.
3. **One write path per side.** Client: `mutate()`. Server: `applyChanges()` (+ change set recording, Phase 0). Never write `records` directly.
4. **Soft delete everywhere.** `deleted: true`. Hard delete only via admin purge (Phase 5). Archive ≠ delete (Phase 3 adds `archived`).
5. **Pure shared logic.** Anything both client and worker need (field coercion, filters, markdown, templates, link ids, cycle checks) lives in `shared/` as pure functions with unit tests in `tests/`.
6. **Every server-side (non-client) write is attributable and undoable.** MCP, automations, forms → change sets (Phase 0).
7. **Progressive disclosure UI.** New capability = contextual action or view option, not a new top-level screen, unless it is a primitive (Inbox, Search).
8. **Backward compatibility.** Missing new fields mean old behaviour. No data migrations of existing records unless a phase doc says so.
9. **Cross-platform acceptance is part of architecture.** Content-driven layouts, container-adaptive embedded views and equivalent touch/keyboard actions apply to every feature. WCAG 2.2 AA is the target; dragging/hover/shortcuts cannot be the only way to complete an operation.
10. **Honest local-first reliability.** Distinguish in-memory drafts, acknowledged local saves, pending records/media and server synchronization. Browser storage and background execution are not guaranteed; specify recovery, foreground retry and capability fallbacks.

## 4. Canonical data model (target, all phases)

Legend: **[G]** generic `records` collection (synced to clients), **[T]** dedicated D1 table (server-side), phase in brackets.

| Entity | Storage | Key fields | Phase |
|---|---|---|---|
| User (login seat) | [T] `users` | id, username, name, role, color | existing |
| Page | [G] `pages` | title, icon, parentId, order, isTemplate, archived [3] | existing |
| Block | [G] `blocks` | pageId (owner id), parentType `page`\|`record` [1], type, text, order, fileId, url [1] | existing |
| Database (was "board") | [G] `boards` | name, icon, kind `tasks`\|`records` [1], columns (stages), fields (FieldDef[]), order | existing → [1] |
| Record (was "task") | [G] `tasks` | boardId, title, status (stage id), order, parentId [1], built-ins (assigneeId, dueDate, priority, coverFileId), `p_<fieldId>` values | existing → [1] |
| View | [G] `views` | databaseId, name, type, order, config | [1] |
| Link (relation / dependency / related) | [G] `links` | fromType, fromId, toType, toId, kind, fieldId | [1] |
| Comment | [G] `comments` | targetType, targetId, body, authorId | existing |
| Activity | [G] `activity` | actorId, verb, targetType, targetId, meta | existing |
| File | [G] `files` + [T] `files`/`file_chunks` | parentType, parentId, kind (`link` for Drive [1]), url [1] | existing → [1] |
| Mood board / item | [G] `moodboards`, `mooditems` | item types extended [2] | existing → [2] |
| Change set | [T] `changesets`, `changeset_items` | tool, client, before/after | [0] |
| MCP request (idempotency) | [T] `mcp_requests` | user_id, request_id, result | [0] |
| Notification | [T] `notifications` (server-only; recipient-scoped REST, never synced) | user_id, kind, target, title/body snapshot, read_at | [4] |
| Form | [G] `forms` (config) + [T] `form_tokens`, `form_submissions`, `rate_limits` | databaseId, field mapping | [4] |
| Approval | [T] `approvals` (server-only; decided by REST/MCP, gate enforced inside `applyChanges`) | target, approverId, status | [4] |
| Automation | [G] `automations` (config) + [T] `automation_runs`, `date_offset_marks`, `rhythm_sweep_cursors` | trigger, conditions, actions | [4] |
| Event outbox / date index / reminder dedupe | [T] `event_outbox`, `date_index`, `reminder_sent` | durable derived-work queue | [4] |
| Search index | [T] FTS table | record text | [5] |
| Space / membership | [T] `spaces`, `space_members` | role | [5] |

**People, Organizations, Projects, Programs, Events, Experiments, Places, Opportunities, Decisions, Meetings, Ideas, Media, Transactions** are all **databases** (`boards` with `kind: 'records'`) created from templates (Phase 3). They are *not* collections or tables.

**User vs Person**: a User is a login seat (≤7 now). A Person is a record in the People database (hundreds). A team member's Person record has a `person`-type field pointing at their User id. Never duplicate contacts per role; roles are a multi-select/relation on the Person.

## 5. Cross-cutting conventions

- **IDs**: `crypto.randomUUID()` (36 chars). Deterministic ids where dedupe matters (links: Phase 1 §3.4). Max id length 64 (enforced by sync validator).
- **Order keys**: fractional indexing via `shared/order.ts` `orderBetween` (tolerant of legacy keys).
- **Timestamps**: client HLC (`src/core/hlc.ts`); server writes use `serverTs` restamping (`max(now, maxFieldTs+1)`).
- **Revision**: `records.seq` is the record revision ("rev") exposed to MCP (Phase 0).
- **Activity verbs**: reuse existing (`created, renamed, deleted, completed, moved, assigned, commented, mentioned, captured`); add new verbs only with matching `verbText` in `src/modules/activity/index.tsx`.
- **MCP tool results**: JSON text via `txt()`; errors via `err()` with `isError: true`; conflicts use the shape in Phase 0 §4.2. Always include app URLs of created/changed items.
- **Limits**: ≤500 record writes per server operation; ≤100 records per create call; ≤200 blocks per page operation.

## 6. Phase dependency graph

```
Phase 0 (safe AI editing) ──► Phase 1 (databases + linking) ──► Phase 2 (visual)
                                         │                       │
                                         └──► Phase 3 (TCG pack) ◄┘ (calendar/timeline/dashboard blocks)
                                                     │
                                         Phase 4 (rhythm: notify, forms, automations)
                                                     │
                                         Phase 5 (search, permissions, guests)
                                                     │
                                         Phase 6 (AI workflows)
```

Phase 4's event pipeline hooks into the Phase 0 change-set/`applyChanges` path. Phase 5 permissions touch every read/write path — do it after the data model has stabilised.

## 7. Verification baseline (every phase)

`npx tsc --noEmit`, `npm run build`, `npx vitest run`, `bash scripts/smoke.sh`, `node scripts/verify-v4.mjs`, `node scripts/verify-mcp.mjs` (against `wrangler dev --port 8788` running the built app), plus the phase's own tests. Deploy to a temporary staging Worker + D1 + KV first; production checks are read-only. Never write data or sign up on production.

For future phase execution, also follow [platform verification §§9–10](cross-platform-responsive-web.md#9-reproducible-verification-strategy): local Playwright Chromium/Firefox/WebKit, phone/tablet/desktop functional and visual checks, keyboard/accessibility, offline/reconnect and multi-device scenarios, plus focused real Safari/iPhone/iPad/Android checks. Engine emulation does not verify operating-system keyboards, permissions, media formats, storage eviction or suspension. Tests run locally without paid infrastructure or a GitHub Actions dependency; real-device HTTPS setup must be authorized separately if it provisions staging infrastructure.

Every phase has a cross-platform Definition of Done. Record exact engines/devices/builds and distinguish passed, failed, fallback and not run. Desktop Chromium success alone cannot establish feature completion. Existing scripts currently cover Chromium and selected phone emulation; the proposed multi-engine platform runner is not implemented. The architecture-only review adds no test results or deployment authorization. The unchanged staging rollout requirement above applies when an implementation phase is separately authorized.

## 8. Open items to verify during implementation (do not assume)

- D1 `batch()` transactional semantics (relied on in Phase 0 §4.2 — confirm in current Cloudflare D1 docs).
- D1 expression indexes on `json_extract(...)` being used by the planner (check with `EXPLAIN QUERY PLAN` locally).
- D1 FTS5 availability (Phase 5).
- Google Drive `/preview` iframe embedding behaviour for files shared "anyone with link" vs restricted (Phase 1 §8).
- MCP Apps (in-chat UI) support per host: documented for Claude; ChatGPT uses its own Apps SDK; Gemini unconfirmed (Phase 2 §7).
- Cloudflare Cron Triggers on the free plan (Phase 4).
- Exact supported browser/OS builds, editor input/undo on real software keyboards, recording/playback codecs, quota/cache/update recovery and Phase 5 offline permission freshness (platform specification §11). No universal Safari retention period or background sync guarantee.
