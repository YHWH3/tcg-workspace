# Phase 2 — Visual workspace

Goal: make project management visual. Mood boards become linked canvases (live task/page/record cards, frames, connectors, shapes, safe SVG, diagrams) that AI clients can build and edit. Add calendar and timeline views to databases.

Depends on Phase 0 (revs, change sets) and Phase 1 (records, links, views). Re-detail to Phase 0/1 level before building.

---

## 1. Mood item model (extend `mooditems`)

```ts
interface MoodItem {
  boardId: string; x: number; y: number; w: number; h: number; z: number; deleted?: boolean;
  type: 'image' | 'note' | 'text' | 'color'          // existing
      | 'card'        // live card for a record or page
      | 'frame'       // named region; items inside move with it
      | 'shape'       // rect | ellipse | diamond | pill, fill/stroke/label
      | 'svg'         // sanitised SVG file rendered as <img>
      | 'diagram'     // structured node/edge spec rendered by the app
      | 'connector';  // arrow between two items
  // card
  ref?: { type: 'record' | 'page'; id: string };
  // frame
  title?: string; frameStageOf?: { databaseId: string; stageId: string } | null; // optional: frame mirrors a stage
  // shape
  shape?: 'rect' | 'ellipse' | 'diamond' | 'pill'; fill?: string; stroke?: string; text?: string;
  // svg
  fileId?: string;
  // diagram
  spec?: DiagramSpec;               // single LWW field; diagrams are edited as a unit
  // connector
  from?: string; to?: string;       // mood item ids
  label?: string; style?: 'solid' | 'dashed'; arrow?: 'end' | 'both' | 'none';
  linkKind?: 'blocks' | 'related' | null;   // if set and both ends are cards → mirrored as a `links` row
  linkId?: string | null;           // the mirrored links.id (back-reference, see lifecycle below)
  parentFrameId?: string | null;    // membership (computed on drop, stored)
  // existing: text, color, taskId (legacy; migrate reads: taskId → ref {record})
}
```

- `taskId` (legacy "make task") is read as `ref: {type:'record', id: taskId}`; new writes use `ref`.
- Connector↔link lifecycle: a connector with `linkKind` stores the created `links.id` in `linkId`. Deleting the connector also deletes its link (same `mutate`/`applyChanges` call). Deleting the link from elsewhere clears the connector's `linkKind`/`linkId` (it degrades to a plain visual arrow) — both directions are best-effort `patch` writes, not cascades, so a missed cleanup just leaves a dangling reference that renders as a plain arrow.
- Connector geometry is derived from endpoints at render time (x/y/w/h ignored).
- Frames: moving a frame moves items whose `parentFrameId` = frame id (one write per moved item, in one change set for MCP; client batches in one `mutate` loop).
- `frameStageOf`: dropping a card on a stage-mirroring frame sets the record's stage (two-way: record stage changes don't auto-move cards — avoid surprise jumps; show a "stage mismatch" dot instead).

### DiagramSpec

```ts
interface DiagramSpec {
  layout: 'auto-lr' | 'auto-tb' | 'manual';
  nodes: { id: string; label: string; shape?: 'rect'|'ellipse'|'diamond'|'pill'; color?: string; x?: number; y?: number; ref?: { type: 'record'|'page'; id: string } }[];
  edges: { from: string; to: string; label?: string; style?: 'solid'|'dashed' }[];
}
```

Renderer: pure layout `shared/diagramLayout.ts` (simple layered layout: longest-path ranks, barycenter ordering, fixed spacing; no new dependency) → React SVG. Node `ref` makes nodes clickable. Limits: ≤200 nodes, ≤400 edges.

---

## 2. Safe SVG

- `shared/svgSanitize.ts` (pure, heavily unit-tested): parse with a small tolerant XML tokenizer (no DOM in Workers), allowlist elements (`svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask title desc use symbol`), allowlist presentation attributes, `href`/`xlink:href` only `#fragment`, drop `style` containing `url(` other than `#`, drop all `on*`, `script`, `foreignObject`, `iframe`, `image` with external href, `<!DOCTYPE>`/entities. Size ≤1 MB, ≤20k nodes. Output canonical string or reject.
- Server sanitises on MCP import; client sanitises on upload/paste. Stored as `files` record `mime image/svg+xml`.
- Serving: `/api/files/:id` and public file route send `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `X-Content-Type-Options: nosniff` for SVG. Rendered only via `<img>`.

---

## 3. Canvas UI (`src/modules/moodboards/MoodCanvas.tsx`)

- Toolbar adds: Card (pick record/page), Frame, Shape, Connector tool (drag from item edge handle to another item), SVG upload, Diagram (opens a small spec editor: list of nodes/edges with labels; "Auto layout").
- Live cards render from Dexie (title, stage chip, assignee avatar, cover thumb, blocked badge, sub-progress); deleted target → greyed "Deleted" card with Restore if permitted.
- Selection: multi-select (shift/drag marquee), align/distribute, group into frame.
- Keyboard (desktop): Delete, ⌘D duplicate, arrows nudge, ⌘G frame.
- Mobile: pan/zoom/move/resize already; connector creation via "Connect" action on a selected item then tap target.
- Performance: render only items intersecting viewport (+margin) when >300 items.

---

## 4. Calendar and timeline views (extend `views.type`)

```ts
type ViewType = 'board' | 'table' | 'list' | 'gallery' | 'calendar' | 'timeline';
interface ViewConfig { /* Phase 1 … */ dateKey?: 'dueDate' | `p_${string}`; endDateKey?: 'dueDate' | `p_${string}` | null; timelineScale?: 'week' | 'month' | 'quarter'; }
```

- Calendar: month grid (desktop), agenda list (mobile); drag to reschedule writes `dateKey`; unscheduled tray.
- Timeline: bars from `dateKey` → `endDateKey` (or 1-day), grouped by `groupBy`; drag/resize writes dates; dependency arrows from `links(kind='blocks')`; "blocked starts before blocker ends" highlighted.
- Unified calendar (Phase 3 dashboard) = a calendar block over multiple databases (`sources: {databaseId, dateKey, filters}[]`).

---

## 5. MCP tools

| Tool | Purpose |
|---|---|
| `get_moodboard` | items with geometry, type-specific props, `rev`, resolved card titles, frames membership |
| `add_mood_items` (extend) | new types; `ref` by id or `{database, title}`; `frame` placement by frame id/title |
| `update_mood_items` | geometry/text/color/label; `expectedRev` optional (geometry LWW is fine) |
| `connect_items` | create connector(s) `{from, to, label?, linkKind?}`; if `linkKind` and both are cards → also writes `links` row |
| `add_frame` | `{title, items?: ids, around?: 'items'\|{x,y,w,h}, stage?: {databaseId, stage}}` |
| `layout_moodboard` | `{algorithm: 'grid'\|'flow-lr'\|'by-frame'\|'by-stage', items?: ids}` server-side layout → geometry writes |
| `add_svg` | `{svg: string \| url}` sanitised; rejects with reasons |
| `add_diagram` / `update_diagram` | `{spec}` validated; `expectedRev` required on update (spec is a unit) |
| `board_to_canvas` | create a canvas with frames per stage and cards for a database/view (one-shot visual of a project) |
| `add_view` (extend) | calendar/timeline config |

Instructions text: describe item types, that cards are live, and that connectors with `linkKind` create real dependencies.

---

## 6. Public sharing

Phase 2 adds optional read-only public canvas: `shares` gains `target_type ('page'|'moodboard')` (migration). Public canvas renders images/notes/text/colors/shapes/svg/diagrams; cards show title + stage only; connectors shown. Files allowed = those referenced by items on that canvas (extend `publicAccess.ts` with `allowedCanvasFiles`).

---

## 7. Optional: in-chat interactive canvas (MCP Apps)

- Documented host support: Claude (per MCP Apps docs). ChatGPT has its own Apps SDK (verify compatibility before building); Gemini unconfirmed. Treat as progressive enhancement; every tool still returns the app URL.
- Design: one `ui://workspace/canvas` resource (single bundled HTML built by a separate Vite entry `src/apps/canvas-app.tsx`, read-only render + simple move/connect) referenced from `get_moodboard`'s `_meta.ui.resourceUri`. App calls `update_mood_items` / `connect_items` through the host bridge. CSP: no external origins; images via data URLs returned by a `get_mood_assets` tool (thumbnails only, ≤200 KB each).
- Gate behind capability detection; if the host doesn't support UI, nothing changes.

## 8. Tests (outline)
`svgSanitize.test.ts` (known XSS payload corpus, round-trip of benign icons), `diagramLayout.test.ts` (determinism, no overlaps for DAGs ≤50 nodes), view date logic tests, Playwright: connector creation desktop+mobile, card live update after MCP stage change, frame move carries children, timeline drag writes dates, public canvas file access denial for unreferenced files.

## 9. Acceptance
AI can build a canvas of live linked task/page cards with frames and arrows that the team then edits by hand; SVGs are safe; calendar and timeline views work on databases; dependencies are visible on timeline and canvas.
