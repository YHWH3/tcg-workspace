# Phase 2 implementation design — visual workspace

Implementation-ready detail for `phase-2-visual.md`, written against `codex/phase-2-visual-workspace` (branched from `4261318`, the Phase 0+1 reviewed head). Read with `phase-2-visual.md` and `cross-platform-responsive-web.md` (binding); §5/§10 there are restated here only where they change file-level design.

## 0. Current-state inventory (what exists)

- `mooditems` rows: `{boardId, x, y, w, h, z, type:'image'|'note'|'text'|'color', fileId?, text?, color?, taskId?, deleted?}` — all flat LWW fields; `boards`/`moodboards` untouched.
- `MoodCanvas.tsx` (627 lines): single-select, pointer pan/pinch/move/resize, wheel zoom, commit-on-release, comment-badge slot, "make task" (`taskId`, legacy), palette extraction. No multi-select, frames, connectors, shapes, svg, diagram, culling, keyboard ops, inspector, or item list.
- `views` rows: `type ∈ board|table|list|gallery`; `ViewConfig {filters, sorts, groupBy, visible, cover, mine, showSubrecords}`; eval in `shared/views.ts` (`applyView`, FieldKey incl. `p_<fid>`/`rel_<fid>`).
- MCP: `createWorkspaceServer` in `worker/mcp.ts`; mutating tools via `reg()` wrapper → `write(env, ctx, userId, ops)` + `beginChangeset/commitChangeset`, `requestId` idempotency, `dryRun`, `expectedRev` → WriteConflict §4.3. `casUpdate` threads real user.
- Shares: `shares(token → page_id)` (migration 0003); `worker/public.ts` + `worker/publicAccess.ts` (pure `descendantIds`/`canServePage`/`allowedFileIds`); PublicView.tsx outside auth shell.
- Files: chunked upload `POST /api/files/:id/chunks/:n`, `GET /api/files/:id` (bearer) — headers need SVG branch.
- `shared/linkid.ts` deterministic ids; `links` rows `kind:'related'|'blocks'|'relation'`; `deps.ts` cycle checks; `order.ts` fractional keys.

## 1. Data model deltas

### 1.1 `mooditems` — additive fields only (no SQL migration; generic records)

New `type` values: `'card' | 'frame' | 'shape' | 'svg' | 'diagram' | 'connector'` (existing 4 preserved).

| Field | Type | Semantics |
|---|---|---|
| `ref` | `{type:'record'|'page', id:string}` | card target. Reads treat legacy `taskId` as `ref:{type:'record',id:taskId}` (`shared/mooditems.ts` `cardRef()`); new writes use `ref`. |
| `title` | string | frame title (also shape/connector label reuse is separate fields) |
| `frameStageOf` | `{databaseId:string, stageId:string} \| null` | frame mirrors a stage — drop inside writes record `status` |
| `shape` | `'rect'\|'ellipse'\|'diamond'\|'pill'` | shape kind; `fill`,`stroke`,`text` reuse existing color/text fields? **No** — keep `text`/`color` for notes/colors; shapes get `fill`,`stroke`,`text`. |
| `fileId` | string | svg → `files` row `mime:'image/svg+xml'` (sanitized on write) |
| `spec` | `DiagramSpec` | single LWW field; edited as unit with `expectedRev` |
| `from`,`to` | string | connector endpoints (mooditem ids); geometry derived at render; x/y/w/h ignored for connectors |
| `label` | string | connector label |
| `style` | `'solid'\|'dashed'` | connector style; `arrow:'end'\|'both'\|'none'` |
| `linkKind` | `'blocks'\|'related' \| null` | if set + both ends are record-cards → mirrored `links` row |
| `linkId` | `string \| null` | mirrored `links.id` (best-effort back-ref, not cascade) |
| `parentFrameId` | `string \| null` | frame membership, set on drop/move end and by MCP `add_frame`/`layout` |

`DiagramSpec` (validated by `shared/diagramLayout.ts`): `layout:'auto-lr'|'auto-tb'|'manual'`, `nodes[{id,label,shape?,color?,x?,y?,ref?}]`, `edges[{from,to,label?,style?}]`; limits ≤200 nodes / ≤400 edges.

### 1.2 `views` — additive config + two types

`ViewType` gains `'calendar' | 'timeline'`. `ViewConfig` gains:
`dateKey?: 'dueDate' | \`p_${string}\``, `endDateKey?: 'dueDate' | \`p_${string}\` | null`, `timelineScale?: 'week'|'month'|'quarter'`.

All values are date-only `yyyy-mm-dd` strings (existing `dueDate` is already date-only; `fields.ts` date type validated as `yyyy-mm-dd`). **Date-only rule:** bucket/compare by string/UTC-midnight arithmetic in `shared/dates.ts` — never `new Date(str)` local-midnight parsing that shifts across timezones.

### 1.3 `shares` — migration `0006_share_targets.sql`

```sql
ALTER TABLE shares ADD COLUMN target_type TEXT NOT NULL DEFAULT 'page';
CREATE UNIQUE INDEX IF NOT EXISTS shares_target ON shares (target_type, page_id);
```
`POST /api/shares` accepts `{targetType:'page'|'moodboard', pageId}` (name kept `pageId` field for compat — the row's target id). List/delete unchanged, keyed by `(target_type, page_id)`.

## 2. File/module plan

### shared/ (pure, unit-tested)

| File | Exports |
|---|---|
| `shared/mooditems.ts` | `MoodItem` type (superset), `cardRef(item)` (legacy taskId→ref), `itemBounds(item)`, `itemsInRect`, `marqueeSelect`, `alignOps(sel, op)` → per-item geometry patches, `distributeOps`, `frameMembership(items)` (contains-test by rect, largest-overlap wins), `connectorPath(fromItem,toItem)` → anchor points, `normalizeItem` (defaults per type), `cullItems(items, viewportWorld, margin)`. |
| `shared/svgSanitize.ts` | `sanitizeSvg(input: string) → {ok:true, svg:string} \| {ok:false, reasons:string[]}`. Tolerant XML tokenizer (no DOM — runs in Workers); allowlist elements (`svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask title desc use symbol`); allowlist presentation attrs; `href`/`xlink:href` must be `#fragment`; `style` attr allowed only without `url(` except `#`; drop all `on*`, `script`, `foreignObject`, `iframe`, `image` with non-`#` href, DOCTYPE/entities. Limits: ≤1 MB input, ≤20k nodes. Canonical serialization. |
| `shared/diagramLayout.ts` | `validateDiagramSpec(spec) → {ok, spec \| reasons}`; `layoutDiagram(spec) → positioned nodes+edges` — longest-path layering + barycenter ordering, fixed spacing, deterministic (sorted ids on ties). ≤50-node test asserts no overlaps. |
| `shared/dates.ts` | `parseDateOnly(str)`, `addDays`, `daysBetween`, `monthGrid(year, month)` → `DateCell[]`, `isoWeek`, `scaleRange(scale, anchor)` — all UTC-midnight, no tz shift. |
| `shared/canvasLayout.ts` | `layoutBoard(items, algorithm, opts) → Map<id,{x,y,w,h}>` for `grid`, `flow-lr` (topo order left→right), `by-frame`, `by-stage` — pure so MCP `layout_moodboard` and client "tidy" share it. |
| `shared/calendarView.ts` | `recordsForCalendar(rows, cfg)` → `{day → records[]}`, `unscheduled(rows, cfg)`; `timelineBars(rows, cfg)` → `{start, end, record}` sorted; `timelineConflicts(bars, blocksEdges)` → bar ids whose start < blocker end (dependency conflict flags). |
| `shared/views.ts` | extend `ViewType`, `ViewConfig`; `resolveDateKey(cfg)` default `dueDate`. |

### worker/

| File | Change |
|---|---|
| `worker/mcp.ts` | New tools (§5): `get_moodboard`, `add_mood_items` (extend), `update_mood_items`, `connect_items`, `add_frame`, `layout_moodboard`, `add_svg`, `add_diagram`, `update_diagram`, `board_to_canvas`, `add_view` extended (calendar/timeline cfg). All via `reg()` → per-request identity, requestId, dryRun, changeset+undo, expectedRev where required (`update_diagram` required; geometry optional). |
| `worker/shares.ts` | `target_type` on create/list/delete; `moodboard` target existence check on `records` collection `moodboards`. |
| `worker/public.ts` | `/api/public/canvas/:token` → sanitized canvas payload (items minus private data: cards → title+stage only, no bodies); file route extended to canvas-allowed files. |
| `worker/publicAccess.ts` | `allowedCanvasFiles(items)` — fileIds referenced by items on that board only (+thumbs); pure, unit-tested. |
| `worker/files.ts` | `GET /api/files/:id` + public file route: when `mime='image/svg+xml'` add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` + `X-Content-Type-Options: nosniff`. Upload path rejects non-sanitized svg (`svgSanitize` on worker). |
| `migrations/0006_share_targets.sql` | above. |

### src/ (client)

| File | Change |
|---|---|
| `src/modules/moodboards/api.ts` | `MoodItem` → shared type; `addMoodItem` accepts all new fields; `addCard`, `addFrame`, `addShape`, `addConnector`, `moveWithFrame` (frame drag → batch mutate children), `setStageFromFrame`. |
| `src/modules/moodboards/MoodCanvas.tsx` | **Rework** (see §3): mode state, selection set, marquee, inspector, item list, culling, connectors overlay (SVG layer), gesture hardening. |
| `src/modules/moodboards/items/` | `CardItem.tsx` (live record/page card from Dexie: title, stage chip, assignee, cover thumb, blocked badge, sub-progress; deleted→greyed+Restore), `ShapeItem.tsx`, `SvgItem.tsx` (`<img>`), `DiagramItem.tsx` (React SVG from `layoutDiagram`), `FrameItem.tsx`, `ConnectorLayer.tsx`. |
| `src/modules/moodboards/Inspector.tsx` | selected-item(s) panel: numeric x/y/w/h, z order, duplicate/delete, frame membership picker, align/distribute, connect action, card target editor. `AdaptiveDialog` on compact. |
| `src/modules/moodboards/ItemList.tsx` | accessible checklist of all items (searchable, multi-select parity, focus item, edit ops) — the non-spatial path; survives culling. |
| `src/modules/moodboards/ConnectFlow.tsx` | source→target by tap or searchable picker; direction/label/linkKind; cancel; delete connector. |
| `src/modules/boards/views/` | `CalendarView.tsx` (month grid ≥md, agenda <md + unscheduled tray + date editor), `TimelineView.tsx` (grouped bars + dependency arrows + conflict flags; compact = grouped date-range rows). Drag optional — every schedule op has a date dialog. |
| `src/modules/boards/` (view switch) | `VIEW_TYPES` extended; `dateKey`/`endDateKey`/`timelineScale` pickers in view config UI. |
| `src/public/PublicCanvas.tsx` | `/s/:token/canvas` read-only renderer: shapes/images/notes/svg/diagrams/connectors, cards show title+stage only, item list + zoom controls, no edit surface, `noindex`. |
| `src/modules/pages/Share.tsx` (or equivalent) | moodboard share entry — 'Share canvas' on board menu. |

## 3. Canvas interaction model (gesture state machine)

```
modes: 'browse' (pan only) | 'edit' (select/move/resize/connect)
gesture = idle
  | pan{pointers≥1 on bg} 
  | pinch{2 pointers anywhere}
  | move{ids[], startGeom[]}
  | resize{id, handle, orig, aspect}
  | marquee{startWorld, current}
  | connect{fromId, preview}
  | dragCard{...} // future-proof, not required
```

- **Entry:** pointerdown on bg → pan (browse mode always pans; edit mode: bg pan too — marquee needs modifier? **Decision:** in edit mode, bg drag = marquee, pan via space/toolbar Browse button/two-finger pinch. Compact default = browse; toolbar toggle). Any second pointer → pinch, item gesture cancelled and draft restored.
- **Commit rule:** geometry writes only on `pointerup`/`lostpointercapture` with `moved===true` — single `mutate` per item (frame children batched). `pointercancel`/Escape → restore `orig` draft, zero writes. Rotation/resize observer → cancel active gesture first.
- **Wheel:** ctrl/cmd → zoom to cursor; plain → pan. Wheel listener stays on the canvas element only (page scroll unaffected outside).
- **Touch:** `touch-action: none` scoped to the canvas surface div only; resize/connect handles rendered at `max(24px/zoom, ...)` screen px (44px touch goal where space allows). Hit-test padding widened at coarse pointers.
- **Keyboard (edit mode):** arrows nudge (shift=×10), ⌘D duplicate, ⌘G group into frame, Delete/Backspace delete, Escape cancel/close, Enter edit text/open card, Tab cycles items. Single-letter keys only when focus is on canvas region (2.1.4).
- **Frame move:** `move` gesture on frame ⇒ final patch writes frame x/y + `x+dx,y+dy` for every member (`parentFrameId` match) in one mutate loop. Membership recomputed on item drop (rect containment → `parentFrameId`), and cleared when dropped outside.
- **Stage-mirror frames:** drop card into `frameStageOf` frame ⇒ writes record `status=stageId` (record write, not item write) + item `parentFrameId`. Record stage change elsewhere does NOT move the card — card shows "stage mismatch" dot.
- **Culling:** `items.length > 300` ⇒ render only `cullItems(items, worldViewport, margin=1.5×)`; connectors culled unless an endpoint visible; selected/editing items always rendered; item count + "N hidden" indicator; ItemList unaffected.
- **Selection model:** `sel: Set<string>` replaces `sel: string|null` — shift-click toggles, marquee sets, ItemList checkboxes toggle, Escape clears. Toolbar/inspector act on the set (align/distribute need ≥2, delete/frame all).

## 4. Connector↔link lifecycle (one write path per side)

- `connect_items`/UI Connect with `linkKind` and both `cardRef(type='record')` ends: writes `links` row `{fromId: cardA.ref.id, toId: cardB.ref.id, kind: linkKind, id: linkId(...)}` AND `mooditems` connector `{from:itemA,to:itemB,linkKind,linkId}` in the same mutate/applyChanges batch.
- Connector delete ⇒ also writes `links.linkId` deleted (same batch). Link deleted elsewhere ⇒ connector degrades: reconciler in `get_moodboard` (server) and `useMoodItems` derivation (client) treats dangling `linkId` as plain arrow; best-effort `patch` clears `linkKind/linkId` on next observed mismatch. Never cascades.
- Client `remove(connector)` ⇒ batch mutate [connector.deleted, link.deleted].

## 5. MCP tools (all via `reg()` — per-request identity, requestId, dryRun, changeset)

| Tool | Input | Notes |
|---|---|---|
| `get_moodboard` | `{boardId}` | items w/ geometry, type props, `rev`, resolved card titles (`ctx` caches), frame membership; `dangling` connectors flagged. |
| `add_mood_items` | `{boardId, items:[{type, x,y,w,h,z?, …typeProps, ref?, spec?}]}` | extends existing; `ref` accepts `{id}` or `{database, title}` resolve via `ctx`; `svg` type requires `add_svg` (content can't ride inline). |
| `update_mood_items` | `{updates:[{id, expectedRev?, x?,y?,w?,h?,z?,text?,color?,fill?,stroke?,label?,parentFrameId?,ref?}]}` | geometry LWW; non-geometry guarded by expectedRev when passed. |
| `connect_items` | `{boardId, connects:[{from,to,label?,style?,arrow?,linkKind?}]}` | writes connector items (+ mirrored `links` when linkKind + both cards). Dedupes: existing connector from→to returns it (idempotent-ish via requestId anyway). |
| `add_frame` | `{boardId, title, items?:ids, around?:'items'\|{x,y,w,h}, stage?:{databaseId, stage}}` | `around:'items'` → bounding box + padding; sets `parentFrameId` on members; `stage` resolves stage name→column id. |
| `layout_moodboard` | `{boardId, algorithm:'grid'\|'flow-lr'\|'by-frame'\|'by-stage', items?:ids}` | `shared/canvasLayout.ts` positions → batch geometry writes in one changeset. |
| `add_svg` | `{boardId, svg:string} \| {url}` | sanitize via `shared/svgSanitize` (reject w/ reasons) → `files` row via `remotefile`-style import or inline bytes → `mooditems` `{type:'svg', fileId}`. |
| `add_diagram` | `{boardId, x,y,w,h, spec}` | validate + auto-layout if `layout!=='manual'`. |
| `update_diagram` | `{id, expectedRev, spec}` | expectedRev REQUIRED (single field). |
| `board_to_canvas` | `{databaseId, viewId?, boardTitle?}` | creates `moodboards` row + one frame per stage (`frameStageOf`) + card per record in the stage frame + `blocks` deps as `linkKind:'blocks'` connectors. One changeset. Returns canvas URL. |
| `add_view` (extend) | `type:'calendar'\|'timeline'` + `dateKey`, `endDateKey`, `timelineScale` | validates keys resolve to date-capable fields. |

Tool descriptions: cards are live, `linkKind` connectors create real `links` deps/relations, svg is sanitized, dryRun previews.

## 6. Security & sharing

- **SVG:** server-side sanitize on `add_svg`/upload; client-side sanitize on paste/upload before `addFile` (defense in depth — server is authoritative). Served with CSP `default-src 'none'; style-src 'unsafe-inline'; sandbox` + nosniff; rendered via `<img>` only (never inline DOM). Adversarial corpus: `tests/svgSanitize.test.ts` — script/on* attrs, `javascript:` hrefs, external `image`/`use` hrefs, `foreignObject`, entities, nested url(), oversized, malformed.
- **Public canvas:** `target_type='moodboard'` shares → `GET /api/public/canvas/:token` returns board meta + items (fields minimized: card → `{title, stage}` from live record lookup, never body/custom fields) + `allowedCanvasFiles` = fileIds on that board's items only (+thumbs). Same token → both routes; revoke kills both. `PublicCanvas.tsx` mounts outside auth shell like PublicView.
- **Private files on public canvas:** `publicAccess` unit tests assert unreferenced file → 404 and card custom fields absent from payload.
- Files on moodboards that are NOT shared stay behind bearer auth as today.

## 7. Optional MCP-Apps canvas

Deferred to a small follow-up commit if time-boxed: `src/apps/canvas-app.tsx` separate Vite entry → `ui://workspace/canvas` resource on `get_moodboard._meta.ui.resourceUri`; host capability check; every tool still returns the app URL. **Not a release blocker** — the standard web app is the acceptance surface.

## 8. Calendar & timeline detail

- **CalendarView:** month grid (7×N cells, `monthGrid` from shared/dates), records chip in day cell (groupBy optional colors); drag between cells writes `dateKey` (fine pointers only); every chip has "Edit date" menu → native `<input type=date>` + clear. Compact: agenda list (next 30 days from anchor + date nav) + unscheduled tray + add/reschedule via date dialog. `type=date` inputs, no tz shift.
- **TimelineView:** rows grouped by `groupBy` (default stage); bar = `dateKey→endDateKey` (1-day default); scale week/month/quarter via `scaleRange`; `links kind='blocks'` edges drawn as arrows between bars; conflict = `bar.start < blocker.end` → red flag + text list. Drag/resize writes dates via `mutate`; compact = grouped date-range rows with start/end date editors + text blockers/conflicts (no drag at all).
- View config UI: `dateKey` picker lists `dueDate` + `p_<fid>` where FieldDef.type==='date'; `endDateKey` same + "none".

## 9. Test plan

| Layer | Tests |
|---|---|
| vitest | `svgSanitize.test.ts` (XSS corpus + benign icons round-trip), `diagramLayout.test.ts` (determinism, no overlap ≤50 nodes, limits), `mooditems.test.ts` (marquee/align/distribute/frame membership/culling/cardRef legacy), `dates.test.ts` (tz-shift safety, month grid), `calendarView.test.ts` (bucketing, unscheduled, conflicts), `canvasLayout.test.ts` (grid/flow/by-frame determinism), `publicAccess` canvas cases. |
| e2e (`scripts/verify-v7.mjs` — wrangler+Playwright, 3 engines × desktop+compact) | connector create desktop+mobile connect-flow; card live-updates after MCP stage write; frame move carries children; multi-select align; marquee; culling selected-item stability; svg sanitize reject/accept; timeline drag writes dates + agenda reschedule compact; calendar unscheduled tray; public canvas render + unreferenced file 404; cancelled move/resize leaves no writes; keyboard nudge/delete/duplicate. New `verify-mcp-phase2.mjs`: every tool incl. board_to_canvas happy path + dryRun + expectedRev conflict + requestId replay + changeset undo. |
| perf | 350-item canvas fixture: assert culled DOM count < rendered bound, pan smoothness proxy (commit latency), INP budget measured and reported. |
| Physical | iOS Safari/Chrome, iPad P/Split, Android touch/pen — **NOT RUN** gates, reported as such. |

## 10. Sequencing (milestones → commits)

1. `docs`: this design doc (this commit).
2. `shared`: svgSanitize + diagramLayout + dates + mooditems + canvasLayout + calendarView + views types — with tests.
3. `worker`: migration 0006 + MCP tools + shares/public/files changes + verify-mcp-phase2.
4. `client`: MoodCanvas v2 + items + inspector/list/connect + calendar/timeline views + public canvas.
5. `e2e`: verify-v7 + fixes.
6. Final: full-suite re-verify, PR, report.

Dependencies: 3 & 4 both need 2's APIs; 5 needs 3+4.
