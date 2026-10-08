# Cross-platform responsive web architecture

Status: architectural requirements, **not implementation evidence**. Reviewed 2026-10-08 against `069a5b51392ef7ad93afdeb7d8f82c10d5f8aa0f`. This specification applies permanently to [Phases 0–6](README.md); it is not an eighth phase. Phase 0/1 additions are implementation requirements; Phase 2–6 additions still need detailed schemas, file plans and tests before execution.

## 1. Product compatibility contract

TCG Workspace is one browser-first HTTPS application using the existing React/Vite/Tailwind client, Dexie outbox, Hono Worker, D1, LiveRoom and remote MCP architecture. Windows, macOS, phones, tablets and other capable browsers access the same routes and data. No native project, additional infrastructure service or installation requirement is introduced.

Mobile has functional parity: create, edit, organize, relate, manage, review and undo all operations delivered by the current phase. Different presentation is allowed; losing an operation because a mouse, hover, modifier key or installation is absent is not. Device-specific camera/recording features have equivalent file-upload or text workflows where hardware or permissions prevent capture. Phase-planned operations are not advertised as implemented.

PWA installation, OS sharing, push notifications and host-embedded AI interfaces are optional enhancements. Normal browser tabs must complete core workflows. First sign-in, fetching uncached data, server-authorized actions, transcription and MCP require connectivity. Offline editing requires an existing authorized local session, a successfully loaded shell and working local storage; offline reload additionally requires cached application assets. Never promise first-ever offline access, permanent browser storage or execution while an OS suspends the browser.

### Delivery ownership

| Class | Delivery rule |
|---|---|
| Mandatory platform foundations | Shared navigation, overlays, keyboard/viewport behavior, WCAG 2.2 AA, capability fallbacks, truthful save state and recovery. Apply to new/touched surfaces in Phase 0; complete existing non-canvas foundations before Phase 1 sign-off. Existing canvas foundations finish with Phase 2. Track named baseline gaps rather than claiming browser acceptance early. |
| Phase-specific parity | Each phase's feature has an equivalent compact, touch and keyboard workflow and passes its Definition of Done (§10). |
| Optional enhancements | Installation, share target, push, Background Sync, pressure/tilt and in-chat canvas never gate the browser workflow. |

The independent Phase 0 §0.1 MCP identity fix remains the first implementation priority and may ship alone. Platform work must not hold that security fix. This review starts no implementation or rollout.

## 2. Evidence from the existing checkout

This is a static source review. No rendered browser, real-device, screen-reader, performance or production tests were run for this review. Source behavior is implemented support, not proof it works on every supported device. Existing scripts are test inventory, not newly observed passing results.

| Surface / evidence | Implemented support | Gap or verification required |
|---|---|---|
| `src/core/mobile.ts:4`, `src/core/shell.tsx:289`, `src/index.css:62`, `index.html:6` | 767px width hook; 240px desktop sidebar; mobile menu/search, drawer and module-derived bottom tabs; safe top/bottom padding; viewport-fit and browser zoom allowed. | One binary width rule does not measure available pane width or input. Tailwind `sm` variants and the hook need a coherent mapping. Bottom tabs grow with modules. No shared visual-keyboard sizing or safe left/right treatment; no implemented workspace switcher. |
| `src/core/ui.tsx:93`, `src/core/ui.tsx:193`, `src/core/search.tsx:62` | Native buttons/fields, some names/focus styles; dialog/sheets, Escape/outside dismiss; search keyboard selection. | Popover trigger is a click span. Overlays lack dialog semantics, focus containment/restoration and background inertness. Search uses `w-full` plus inline side margins; overflow must be measured. No keyboard-aware positioning. 20–28px icon controls recur. |
| `src/modules/pages/tree.tsx:38`, `PageView.tsx:108` | Nested page creation, hierarchy, templates, breadcrumbs and backlinks; page menu also exposes sub-page creation. | Tree navigation uses click divs; tree add/options depend on hover. Reparent/reorder interaction is not established as a complete phone workflow. |
| `src/modules/pages/RichInput.tsx:147`, `:334`, `:371`; `BlockEditor.tsx:91`, `:516`, `:578`, `:588` | Token-aware contentEditable, composition guard, plain-text paste via execCommand, mention chips; slash menu, block split/merge, media insertion, HTML drag handle, Move up/down menu; 300ms text debounce flushed on blur/unmount. | Soft-keyboard editing relies heavily on keydown; menus use mouse-down selection and hover reveal. No explicit structural undo/redo model; remote DOM rebuild sends caret to end. Blur/unmount cannot guarantee persistence before OS termination. Touch selection, IME, paste/undo and menu visibility need real Safari/Android tests. |
| `src/modules/boards/Board.tsx:18`, `BoardPage.tsx`, `TaskDetail.tsx:21`, `:132`, `FieldValue.tsx` | Board/list, snap-scrolling columns, mouse + 200ms touch sensors, bottom-sheet task detail, native stage/assignee/date selectors and property editors. Stage selection already provides a non-drag path. | No configured keyboard drag sensor; hover card/image controls; 400px detail pane selected by viewport rather than remaining width; field inputs need stronger labeling and touch spacing. Table/gallery, relations, dependencies and record bodies are Phase 1 plans. |
| `src/modules/moodboards/MoodCanvas.tsx:81`, `:139`, `:340`, `:612` | Pointer capture, pan/pinch, move/resize, wheel zoom, fit, selected-item toolbar; geometry committed at gesture end. | Entire canvas uses touch-none; item and background pointers follow different paths. Pointer cancellation shares commit handling with pointer-up. Resize handle is 14px; no semantic item-list/precision alternative; every item is rendered. Frames/connectors/diagrams/calendar/timeline are Phase 2 plans. |
| `src/modules/boards/Capture.tsx:24`, `:46`, `:69`, `src/core/recorder.tsx:6`, `:24` | Camera hint plus gallery input, voice recording with MIME probing, 5-minute limit, note capture; mobile full-screen route; offline attachment pipeline. | Capture drafts/photos/voice live in React memory until Save; shortcut timers auto-attempt camera/mic without a new gesture; permission errors and interruption recovery unspecified. TaskDetail gives all recordings a .webm name although blob MIME can differ. Object URLs allocated in render need lifecycle management. |
| `src/core/files.ts:47`, `:192`, `:211`; `fileui.tsx:110` | WebP recompression with JPEG fallback; original bytes retained on decode failure; local blobs, 1MiB resumable chunks, 413/507 failed state, retry on later sync; audio and PDF/download renderers. | Blob/metadata writes occur separately; upload/retry and failed states need user recovery. No bounded downloaded-blob cache. PDF iframe/codec/HEIC previews unproved; audio play rejection lacks visible handling. Local quota differs from 450MB server limit. |
| `src/core/auth.ts:30`, `:55`, `shell.tsx:125`; `authscreen.tsx` | Cached session opens offline; 401 drops session while retaining data; sign-out warns about outbox; username/password autocomplete. | Different-account login deletes the entire Dexie DB including pending work. Sign-out check counts only outbox, not pending/failed files or editor drafts. One origin DB and localStorage session are shared across tabs; old-tab behavior during account change is unproved. |
| `src/core/sync/engine.ts:93`, `:137`, `:224`, `:270`; `sync/rebase.ts`; `live.ts:135` | Atomic local record+outbox transaction; HLC field merge/rebase; retry on online/focus/visible, visible polling, socket reconnect jitter; hidden socket teardown scheduled after 60s. | In-memory editor debounce precedes transaction. Sync indicator counts records only and can say Synced with failed media. Push deletes sent entries after successful HTTP without per-id rejection inspection. Network hint is treated as a gate; timeout/backoff/recovery need specification. Timers/sockets cannot assure background delivery. |
| `src/main.tsx:6`, `src/sw.ts:17`, `vite.config.ts`, `install.tsx` | Production SW precache/navigation fallback, API network-only, optional install button and share target; public shares outside auth/sync. | Partial precache failures tolerated, immediate skipWaiting/claim and deletion of old caches may break old tabs/offline updates. No browser-first offline shell readiness UI. Install hints use UA detection and are not capability proof. |
| `src/modules/comments/index.tsx`, `presence.tsx`, `src/modules/activity/index.tsx` | Comments via slots, mobile comment sheet, presence and activity. | Composer relies on placeholder; own-comment controls hide on hover; save/error toasts expire in 4.5s and lack live-region semantics (`files.ts`, `shell.tsx`). Notifications/approvals are Phase 4; permissions/guest caches are Phase 5; AI workflow pack is Phase 6. |
| `scripts/screenshots.mjs`, `editor-test.mjs`, `offline-test.mjs`, `verify-v2/v3/v4.mjs`, `verify-mcp.mjs` | Desktop Chromium and selected 390px mobile emulation; CDP touch tests, offline reload and collaboration scenarios. | No configured Firefox/WebKit suite, tablet/split-window matrix or real OS evidence. CDP gestures are Chromium-specific; emulation does not verify camera, software keyboards, storage eviction or screen readers. |

The MCP handler identity defect remains present at `worker/mcp.ts:1378`; the AGENTS description of a per-request handler describes the intended behavior, not the current source. The platform review does not fix it.

## 3. Browser support and capability policy

### Supported versions

Support the latest two stable major releases of Chrome, Edge and Firefox (plus current Firefox ESR where its underlying engine meets the dependency floor). For Safari support the current and immediately preceding major macOS/iOS/iPadOS release families, using their latest available browser/OS updates. Record exact browser build, OS build and date at each release; do not infer a Safari version from a desktop Chromium result. Review policy each phase and after dependency updates. Preview/beta builds are diagnostic only.

The current Tailwind v4 documentation gives Chrome 111, Safari 16.4 and Firefox 128 as compatibility floors, and explicitly warns that optional utilities such as field-sizing have narrower support [S10]. These are dependency floors, **not promises to support those old versions**. Check the locked React/Vite/router/Dexie bundle against the release matrix before setting the oldest tested build; a dependency upgrade that raises the support floor needs an explicit compatibility decision. Do not widen support with a second stylesheet framework or native app.

| Platform | Required browser coverage | Real-platform coverage |
|---|---|---|
| Windows laptop/desktop | Chrome, Edge, Firefox + eligible current ESR | Real Windows keyboard, mouse, zoom, high contrast, NVDA; branded browser smoke after engine suite. |
| macOS laptop/desktop | Safari, Chrome, Firefox | Real Safari editing/media/SW; keyboard, trackpad and VoiceOver. |
| iPhone | Safari, Chrome | Both browser apps in normal tab mode; Safari on both supported OS families when available; optional installed mode separately. |
| iPad | Safari, Chrome | Portrait, landscape, Split View/resized window; touch plus physical keyboard/trackpad; optional Pencil. |
| Android phone/tablet | Chrome, Firefox | At least one lower-powered physical phone and one tablet; touch, camera, microphone, TalkBack. |
| Other modern devices | Standards/capability-based best effort | Core contract claimed only after equivalent workflow checks; never infer from UA. |

Browser brand is not engine identification. Apple documents region/entitlement-dependent alternative engines on iOS/iPadOS [S17]; record actual browser/OS rather than universally calling every iPhone browser WebKit. Test Chrome on iPhone explicitly even where it shares an engine with Safari. Embedded/in-app browsers are best effort: offer Open in browser if OAuth, storage or permissions are blocked. Browser choice instructions must not become an installation gate.

### Capability and fallback registry

Own browser capability checks in `src/core/` when implemented; keep pure planners in `shared/`. Test the attempted operation and catch denial/failure, not only property existence. No UA switch determines CRUD permission or layout. Existing install hints can use platform instructions without controlling functionality.

| Capability / verified limitation | Required browser-tab behavior / fallback | Owner |
|---|---|---|
| IndexedDB and localStorage can fail; private modes use different quotas and usually erase data on session exit [S1, S2]. | Probe a real write/read/delete transaction and guard settings/session storage. Warn that durability is unconfirmed. If persistence fails, retain the current draft in memory, offer selectable export/copy and retry/normal browsing; do not claim Saved or queue writes in a fake successful store. No silent memory-only replacement for Dexie. Public reads remain online where possible. Private mode is supported only to its capabilities, never promised durable offline storage. | Foundations / Phase 1; shared-device policy Phase 5. |
| Storage is best effort; Safari may evict an origin due to pressure or inactivity, even without a fixed universal deadline [S1, S2]. | Estimate usage, request persistence where supported after explaining why; denial is nonfatal. Preserve unsent work during application-managed cleanup; refetch synced records after local loss. Lost unsynced bytes after OS/browser eviction cannot be reconstructed. | Phase 1, scale Phase 5. |
| SW requires secure context; registration/cache can fail [S11]. | Normal online app keeps functioning. Report offline-shell readiness separately; reload offline only after verified shell cache. Do not store authenticated API responses in CacheStorage. | Phase 1. |
| Installation UI varies; beforeinstallprompt is not universal [S3]. | Optional prompt only when available; manual browser instructions otherwise, always dismissible. CRUD and capture remain reachable in tab mode. | Phase 1. |
| Share target and OS shortcuts are unevenly supported. | Existing manifest is enhancement only; visible Upload, Paste link, Capture and Search routes replace OS entry points. Never promise native sharing on iOS/Firefox without device evidence. | Phase 1 / field mode Phase 3. |
| Camera capture attribute is a hint with limited availability; getUserMedia needs HTTPS and permission [S12, S13]. | Explicit user gesture; keep Choose files/photos alongside camera. Cancel/deny/no hardware returns to draft with actionable text and no repeated prompt. Permission APIs vary: catch operation errors rather than require a permission-query result. | Phase 1 / public forms Phase 4. |
| MediaRecorder formats vary; isTypeSupported does not guarantee successful recording [S4, S14]. | Probe candidates, accept browser default, use actual blob MIME and matching extension; handle constructor/start/error/stop. File upload or text note if unavailable. No recording or transcription success claim from MIME probing alone. | Phase 1. |
| Audio/video playback codecs, photo decoding and PDF viewers vary. | canPlayType plus actual load/error handling; user-initiated playback with playsInline; open/download fallback. Decode/encode failure preserves original within limits or offers Drive link. Unsupported codec never removes the attachment. | Phase 1; Drive introduced there. |
| Clipboard differs by permission and transient user gesture; execCommand is deprecated [S8]. | Normal paste event/selection still usable; explicit Copy catches failure and opens selectable text. Don't require clipboard-read permission. Editor replacement must preserve selection/undo before removing existing execCommand path. | Phase 1 / AI URLs Phase 0. |
| Pointer Events unify input; touch-action controls native manipulation; pointercancel/capture loss can interrupt [S15]. | Scope gesture suppression to active region/handle; define cancel, restore draft geometry, no accidental commit. Single-pointer and keyboard alternatives for every drag/pinch operation. | Phase 1 boards; Phase 2 canvas. |
| Software keyboard changes visual and layout viewports differently [S6, S9]. | Dynamic viewport sizing plus progressive VisualViewport resize/scroll observation; keep focused field/actions visible. No core dependency on experimental VirtualKeyboard API or fixed keyboard heights. | Phase 1 foundations; every phase surface. |
| Lifecycle can freeze timers or discard pages without events [S5]. WebSockets are hints, not persistence. | Commit locally during interaction, best-effort flush on hidden/pagehide, restart auth/sync/presence on pageshow/visible/focus. Treat socket state stale after resume; always reconcile from cursor. | Phase 1. |
| Background Sync has limited browser availability [S7]. | Foreground startup/reconnect/manual Retry is mandatory. Optional background sync, if later measured useful, reuses identity-safe queue; it is neither a completion guarantee nor required here. | Phase 1. |
| iOS/iPadOS Web Push is documented for Home Screen web apps [S16]. | Phase 4 Inbox works in a normal tab and receives updates on foreground sync. Optional push explains platform/install/permission requirements; no required install or delivery guarantee. | Phase 4. |
| Drive iframe access and third-party session behavior vary. | Phone link card; desktop/tablet optional iframe with persistent Open in Drive. A loaded iframe is not proof of authorization/content; cross-origin errors may be unobservable. | Phase 1. |

## 4. Unified responsive layout and shared components

### Layout modes

Use available CSS inline size and content minimums, not OS/device labels. Initial design thresholds for implementation tests: compact below 48rem (768px at default font size); medium 48–74.99rem; expanded at 75rem (1200px). These are starting constraints, adjusted only with fit/zoom evidence. Pointer coarse/fine and hover queries influence affordances, not the availability of operations. A touch laptop or iPad with a mouse can use both inputs without a reload.

| Context | Navigation/content | Detail/editor |
|---|---|---|
| Expanded | Persistent existing sidebar + hierarchy; flexible main region; wide board/table within their own scrolling regions. | Inline detail only if main stays ≥32rem and detail ≥22rem after sidebar; otherwise overlay/full route. Resizable panels, if added within a phase, have limits and keyboard resize/reset actions. |
| Medium / tablet | Collapsible rail/drawer when sidebar would crowd content; split panes only when minimums fit. Rotation/window resize preserves route, draft, selection and scroll. | Overlay detail or full-screen editor when space/keyboard requires it; full actions available with touch and hardware keyboard. |
| Compact / phone | Menu drawer + collapsible hierarchy, visible Search/Create, at most four primary destinations plus More; modules remain discoverable in More/drawer. Safe bottom navigation may retract while editing but editor actions remain reachable. | Full-screen record/document editor for long content; sheets for short property/status/picker tasks. No nested sheet stack that hides dismissal or submit. |

Keep `useIsMobile` in `core/mobile.ts` (avoid module cycles), evolving it into coherent layout capability helpers only when needed; share one breakpoint vocabulary with CSS. Use container queries for embedded database views, dashboards, properties and toolbars: a 360px embedded view stays compact in a wide page. Provide a compact default/media-query fallback if container queries fail; never duplicate application logic by platform.

### Shared component contracts

- Extend existing `ui.tsx`, shell, search, media and module slots; no second component framework without an evidenced need. One action model and write helper serve dialog, sheet and full-screen presentation. Preserve routes/deep links/back navigation. Overlay appearance changes must not remount and lose a draft on rotation.
- Fluid width, min-width:0, logical paddings and wrapping; spacing starts with existing Tailwind 4/8/12/16/24/32px scale. Body/editor starts near 16px with 1.5–1.75 line height; document measure ~60–75 characters on wide screens. Editable mobile controls use at least 16px font and honor text scaling; small metadata must never carry the only action/error.
- Safe areas on all four edges for landscape cutouts, nested footers and installed mode; apply each inset once at owning edge. `100dvh`/`100svh` with a usable percentage/min-height fallback; don't assume dynamic units alone lift fixed toolbars above the keyboard. Observe visual viewport progressively without misinterpreting browser pinch zoom as a keyboard or resetting page zoom.
- One primary vertical scroller per view; overlays have a bounded internal scroller and stable action row. No body-level horizontal overflow at 320px. Wide table/canvas/code may have a labeled contained two-dimensional region plus a compact/non-spatial alternative. Long words, breadcrumbs, URLs, property labels and validation wrap. Focus/caret scrolls into view with toolbar/keyboard margins.
- Popovers fit/flip within available viewport or become sheets; searchable pickers use full-screen compact presentation if keyboard + results cannot fit. Escape closes only the topmost layer. Outside dismiss must not discard unsaved work. Focus returns to trigger or logical successor; route change announces title and restores useful scroll on Back.
- Main actions visible on touch and focus-within; hover may enhance, never reveal the only control. Context menu/right-click/long press and all shortcuts have named buttons. Bulk mode uses Select, checkboxes, count + action sheet; dragging is never the only reorder or status operation.

## 5. Functional parity and interaction models

### Pages, block editor and long record bodies (Phase 1 foundation)

Keep the existing block/token representation and `mutate()` path. Required operations: nested page creation; searchable Move to parent with cycle protection; block insert/type change/delete/Move up/down/Move before-or-after; media; checklists; mentions and backlink navigation. Add explicit Insert and Block actions adjacent to focused/selected block; `/` and hover handles remain accelerators. Existing page menu sub-page creation remains accessible in every mode.

Use input/beforeinput + composition-aware handling for soft-keyboard split, merge and deletion; never require a reliable keydown Enter/Backspace. Preserve native selection, selection handles, copy/cut/paste, dictation, emoji, autocorrect and IME. Do not navigate a mention while selecting through it. Expose chip links and equivalent accessible action; mention/slash pickers need keyboard/tap selection and announced results without blur erasing the session. Long paste normalizes lines/tokens predictably; external HTML remains untrusted/plain-text per existing policy.

Specify editor-local undo/redo for typing, paste, split/merge, insert/delete, type changes and reorder. Keep native text history where safe; use stable block ids and inverse patches for structural operations through `mutate`, not global table snapshots. Don't hijack browser history shortcuts. Undo of local editing is distinct from Phase 0 AI change-set undo; it must refuse or ask to review when a remote edit changed the targeted field, rather than replaying an old whole-document snapshot. Exact inverse/selection adapter design is a Phase 1 implementation task with unit and browser tests.

Toolbar exposes Insert, type, mention, move, undo/redo and media without covering selection. While keyboard is open, keep a compact action row reachable in visual viewport or document flow; caret and active menu stay visible. Code blocks have contained overflow, long text scrolls naturally, iframes/media don't steal editor gesture handling. Remote updates preserve caret/selection where possible; retain a local draft before replacing text that lost LWW, and show a review entry instead of silently jumping to end. No CRDT or client sync-protocol redesign is implied.

Acceptance: on 320/390px and tablet split window, type a multi-screen document, select across mention chips, paste multiline text, compose non-Latin text, split/merge blocks, undo/redo and reorder with actions; attach a file and open backlink; hide/reopen browser and recover every acknowledged locally saved edit.

### Databases, properties, hierarchy and relations (Phase 1)

Same `shared/views.ts` filtering/sorting/grouping semantics for every presentation. A narrow Table view presents named record rows/cards with title and visible-property summary; opening a row provides **all** properties, not only card-visible ones. Label this as the compact presentation of the same view; do not silently save a List view or change workspace view config on resize. Wide table remains an optional contained comparison view. Native table semantics first; interactive-grid ARIA only with complete keyboard model.

Create Database, add/edit/reorder fields/options/stages, New record, view creation/rename/switch, filters, sorts, grouping and visible-property configuration are reachable from compact toolbar/menu. Full-screen record detail preserves route and local draft; property sheets supply labels, type/inputmode, validation and remove/clear actions. View filters show active count and removable chips; long names wrap; cancel leaves config unchanged. If saving a view changes shared config, label that distinction from a local view choice.

Relation/parent/dependency picker: named search field, target database/path subtitle, selected list and single/multi semantics, explicit add/remove/replace, inline creation when allowed, clear ambiguous matches and missing/restricted targets. Paged/windowed results retain selected records and focus; no drag-only links. Sub-record breadcrumbs and Back return to parent; add/reorder/reparent use actions with cycle/depth errors. Blocked by/Blocking lists have searchable add/remove and explain dependency direction. Field-level validation remains shared across devices.

### Kanban, tasks and bulk management (Phase 1)

Retain board columns and list view. Compact board offers stage selector + one-stage list or bounded horizontal snap columns with next-column cue; both expose counts/add task/status. Touch scroll works before drag activation; dedicated lift handle/explicit move mode with cancel avoids fighting scroll/text selection. Preserve the existing stage selector as baseline and add Move to stage/database and position actions so both stage and within-column order can be managed without dragging. Keyboard drag is optional if the action path provides parity; if configured, announcements and Escape cancellation are required. Delete/move-stage consequences use readable confirmation.

Ownership, priority, dates, attachments, description/body, comments, custom properties and bulk selection remain available on phone. Date editing supports native date input plus readable date/clear action; no desktop-only date grid. Don't hide operational fields to fit cards.

### Moodboards, canvas, calendars and timelines (Phase 2)

Build on existing pointer canvas. Explicit Browse/Pan versus Select/Edit mode: one finger pans background; selecting an item exposes Move/Resize; second pointer transitions to pan/pinch without accidentally moving it. Pointer capture release, pointercancel, lost capture, resize/rotation and Escape restore draft geometry; successful release commits once through existing write helpers. Scope touch-action to canvas gesture area; editor/forms keep text selection/scroll. Browser zoom remains available outside canvas and through browser controls; canvas has labeled zoom +/−, reset, fit and pan buttons.

Handle hit areas are measured in screen CSS pixels independent of world zoom (44px touch goal). Selected-item inspector has numeric x/y/w/h, layer order, move-to-frame, alignment and duplicate/delete. Multi-select uses checkboxes/item list as alternative to shift/marquee. Connect action picks source then target by tap or searchable item list; cancel and direction/label editing explicit. Frames editable through item membership list. Diagram editor exposes nodes/edges as labeled rows, referenced-record search, endpoints, auto-layout and validation, with text/outline representation for non-spatial access. Pen uses Pointer Events as equivalent pointer; pressure/tilt/palm features optional, no Pencil-exclusive operation or promised OS gesture override.

Calendar compact = agenda with date picker, unscheduled list, add/edit/reschedule date action. Wide month grid retains drag plus date-dialog alternative. Timeline compact = grouped date-range rows showing blockers/conflicts with start/end editors; optional contained timeline overview. Dependency arrows also appear as text lists. Date-only semantics must not shift with timezone; every calendar/timeline operation possible without dragging bars. Public canvases expose read-only item/connection list and labeled zoom, no editing leaks.

### Operational and AI surfaces (Phases 0, 3–6)

Comments, mentions, presence and activity retain slots and deep links. Presence indicates recent activity, not guaranteed online status after suspension, and must not steal editor focus. Phase 0 AI review presents actor/client/time, counts, warnings, field before/after, skipped undo fields, and affected-item links as stacked rows on narrow screens. Large previews disclose truncation and offer full content/server reads; compact screen cannot remove a warning or undo control. Offline preview/review must say whether current server revision was checked; applying server-only undo/conflict retry waits for connectivity and explicit review.

Phase 3 dashboards adapt inside their block container: metrics wrap, database blocks use compact record presentation, unified calendar becomes agenda. Every metric drills into source records, including phone leadership/project review. Field context search, observation/experiment/expense/project capture and related records work offline within loaded scope; target/context shown before Save. Draft capture is recoverable, not replaced by a default context when that target disappears.

Phase 4 Inbox, reminder preferences, request/decide approval, form builder preview and automation rule editing use stacked forms and action sheets. Public forms operate outside auth in a phone browser with visible labels, input types, validation summary/focus and recoverable draft after network/Turnstile failure. No installation, microphone or camera requirement; gallery/file/Drive/text alternatives. Submission is successful only after server receipt; offline submission is a local draft, never a silent scheduled send. Builder and automation action reorder use buttons as well as optional drag.

Phase 5 space/guest switching, permission-aware search/history, account/session controls and rejected-write recovery use the same adaptive primitives. Phase 6 prompt discovery, result URLs, generated documents/summaries and AI suggestions use browser routes and Phase 0 review; native AI app and embedded host UI optional. Actual host/account connector availability must be verified at implementation; never promise all hosts allow every tool on mobile.

## 6. Accessibility: WCAG 2.2 AA

Target WCAG 2.2 AA for the whole application and public surfaces [S18]. Conformance is not established by this review or automated scanning alone.

- Semantic buttons/links, named navigation/main landmarks and Skip to content; nested page disclosure buttons with expanded state, semantic lists first. A role is a keyboard contract. View tabs, search/mention/relation comboboxes and menus follow full APG patterns; no click-only div or nested interactive button.
- Keyboard completes every operation without drag, pinch or precision pointing. Modal title/role, focus entry/containment, inert background and restoration; nonmodal panels don't trap focus unnecessarily. Focus remains visible and unobscured by sticky bars, keyboard or sheets (2.4.7/2.4.11); route titles announced. Shortcuts discoverable, platform-appropriate Ctrl/Command labels, single-letter shortcuts disable/remap or scope to focus (2.1.4).
- AA target-size minimum is 24×24 CSS pixels or the criterion's defined exceptions (2.5.8); product touch goal is 44×44 with no overlapping targets. Single-pointer, non-drag alternatives meet 2.5.1/2.5.7; label status in text as well as color.
- Text contrast ≥4.5:1 (large text ≥3:1), meaningful UI boundaries/states ≥3:1 as applicable; measure actual light/dark and image surfaces. Honor forced colors, reduced motion and text-spacing overrides. Animation suppression includes spinners/pulses where motion isn't essential; preserve meaningful progress text.
- 200% text resize and 400% browser zoom/reflow equivalent to 320px: no page-level two-axis scrolling, clipped form errors or unreachable actions. Necessary canvas/table two-dimensional regions have non-spatial/compact alternatives and labeled overflow. Never disable user zoom or fix orientation.
- Visible labels/inputmode/autocomplete, associated help/errors, error summary, first invalid field focus. Paste/password managers supported. Avoid cognitive tests without an accessible alternative (3.3.8); Turnstile failure exposes retry/help rather than blocking with an unexplained spinner.
- Stable polite live region for saving/synced/offline/result counts; urgent errors separately announced. Durable error/action messages instead of expiring-only toast; avoid per-keystroke announcements. Comment text wraps, descriptive media alt/title, transcript state readable. Live prerecorded audio-only content needs text alternative; videos requiring captions have an accessible caption/transcript provision (don't claim raw uploads conform automatically). Authoring/media accessibility needs a Phase 1 workflow and Phase 4 form policy.
- Manual VoiceOver (macOS/iPhone/iPad), TalkBack (Android), and NVDA (Windows) checks accompany engine-level accessibility checks. Virtualized lists/tables preserve logical focus, accessible names/counts and selection when offscreen items unmount.

## 7. Local-first reliability and multi-device recovery

Retain per-field HLC LWW, generic records and `mutate`/`applyChanges`; no new wire protocol, CRDT or database schema is enacted here. Different fields merge; simultaneous whole-text/config edits to one field are not collaborative character merging. Phase 0 revisions/CAS protect MCP operations, not offline client edits. A same-user device is another replica with its own outbox/cursor; it is not one shared live editing buffer.

### Persistence and user-visible states

Define observable states: Editing (in memory), Saving locally, Saved on this device / waiting to sync, Syncing, Synced at time, Uploading n/m, Upload failed/retry, Authentication required, and Storage unavailable/full. Metadata sync, bytes upload and transcript completion are separate. Synced means server acknowledgement/reconciliation, never just navigator.onLine or a zero outbox when media remains. Show status in compact chrome and focused-editor context, not only the hidden drawer. Capture Save means local commit; later remote confirmation distinct.

Persist active editor/capture drafts promptly; if debouncing is kept for rendering/network, don't treat in-memory debounce as durable save. Best-effort flush on blur, hidden and pagehide supplements local transactions; unload events are not a guarantee. Account ownership must bind drafts, outbox and files. Keep a recoverable local candidate before a server-winning same-field value replaces a pending human edit; offer compare/copy/reapply through mutate with fresh timestamps after explicit choice. Local recovery is not durable shared audit or a CRDT; Phase 5 adds server history. Exact local recovery representation and limits must be detailed in Phase 1 without changing server record contracts.

### Reconnect and interruptions

On startup, visible/focus/pageshow (including back-forward cache), online signal and manual Retry: recheck auth/network, resume record push/pull then chunk uploads/transcription, refresh presence and data from saved cursor. Network signal is advisory; bounded fetch timeout/abort, retry backoff with jitter and explicit Retry avoid a stuck syncing flag or retry storm. Acknowledgement lost after server commit must replay identical record/chunk identity safely; one tab/network actor must not delete another's queue entry. Test multi-tab simultaneous sync and account change; use existing transaction/coalescing mechanisms before considering an optional cross-tab leader, never assume module globals coordinate tabs.

If OS suspends/kills a tab, acknowledged local writes survive only while origin storage survives. Resume unfinished chunks from durable progress and server acknowledgements with same file id; reattempt complete safely, verify bytes. Failed uploads remain visible with Retry, replace-with-link, download/export or explicit discard, and don't jam record sync. Pause long media work when not active; warn that keeping app open aids upload, don't demand installation. Recording must stop/finalize on lifecycle interruption where possible, release mic/tracks/AudioContext, preserve completed audio segments and explain failure; no guarantee of audio capture while backgrounded or abrupt process death.

### Storage, updates, logout and loss

- Separate origin quota/usage from the server 20MB file / 450MB workspace limit. Bound cached downloaded blobs/thumbnails by LRU and configurable budget; protect pending/failed bytes, draft/outbox and owned unsynced records. Evict only re-fetchable cache with safe recovery; local cleanup never pretends to remove server files. Release image bitmaps, media elements and object URLs. Process large photos serially; limits on decoded dimensions/memory must be measured before implementation.
- Persistence request denied/private/low-space paths remain usable with explicit limits. If storage is missing, rehydrate synced content online; explain inability to recover unuploaded local-only edits. Offer authorized recovery export before destructive local cleanup or account switch; no export includes secrets. No fixed Safari retention-day promise.
- SW cache installation/update must verify required shell assets, keep old active tabs functional until safe handover, never auto-refresh over a draft, and remove only app-owned stale caches. Simulate partial install/cache failures, old tab + new worker and offline deep routes. Keep APIs network-only and classic-script/iife safety.
- Phase 1 foundation: before logout/account replacement count drafts, outbox, pending/failed blobs, and in-flight local transactions; offer stay/sync/recovery export or explicit discard. If a logout attempt is offline, locally lock UI/session and explain that server session invalidation awaits connectivity; do not auto-send retained work under another account. Original user may reauthenticate and resume. Stop old tabs' sync/render on account change before cache transition. Existing behavior that deletes a different user's outbox is a gap to fix, not an acceptable default.
- Phase 5: refine multi-device session controls, shared-device sign-out clearing, permission evictions and guest caches. Unauthorized/revoked content must disappear on the next successful permission reconciliation from Dexie, blobs, object URLs, rendered state, search caches and queued operations. Pending rejected edits need an allowed recovery choice, not endless retries or hidden retention. Offline devices cannot learn revocation instantly; define permission freshness/lease policy during Phase 5 design review and communicate residual offline access. Don't promise remote wipe of a disconnected browser or previously downloaded/exported bytes.

## 8. Phase-impact matrix

Existing support below means source implementation only; all device acceptance remains to be tested.

| Requirement | Existing support | Target phase | Required architecture change | Verification |
|---|---|---|---|---|
| HTTPS browser access / optional PWA | SPA, install control, manifest/SW | Foundation 0–1, every phase | Normal tab is acceptance path; install/share/push optional | No-install login→CRUD→offline/reconnect; blocked SW case |
| Support policy / capability detection | MIME probing, JPEG fallback, width hook | Foundation 0–1 | §3 version matrix and operation-level fallback checks | All 3 engines; real branded browser smoke |
| Adaptive shell, tree and navigation | Binary desktop/mobile shell | 1; space switcher 5 | Content minimums, drawer/More, semantic tree, search/move actions | 320→1920 resize, zoom, rotation, keyboard |
| Shared overlays / keyboard / safe areas | Sheets, top/bottom safe classes | 0 touched surfaces; foundation 1 | Focus/inert/restoration, visual viewport and four-edge safe areas | Keyboard-open picker/undo/auth; iPhone landscape |
| WCAG AA / status readability | Some native controls, labels/focus | 0–6 | §6 including drag alternatives, durable errors and captions | Keyboard + automated checks + VO/TalkBack/NVDA |
| Safe AI review/conflicts/undo/auth | OAuth and Activity; safety additions planned | 0 | Compact stacked diff/warnings, browser consent, online retry state | Mobile review/undo + stale revision + two OAuth users |
| Pages, nested hierarchy, block operations | Editor/tree; hover/key-dependent paths | Foundation 1 | Input/composition handling, explicit block/move actions, local undo | Real soft keyboard, paste/IME/undo, long body, backlink |
| Database CRUD / views / all properties | Board/list + property detail | 1 | Compact table, full detail, filter/sort/configure sheets | Same fixture results and writes desktop/phone/tablet |
| Relations, dependencies, sub-records | Phase 1 plans | 1 | Searchable add/remove/replace, parent navigation, no-drag reorder | Picker ambiguity/cycle/clear and offline resync |
| Kanban / bulk operations | Touch sensor/status select; no keyboard sensor | 1 | Stage/order action alternatives and handle vs scroll | Scroll without move; cancelled lift; keyboard bulk |
| Camera/files/voice/PDF/Drive | File inputs, recorder/chunks; Drive planned | 1; field 3; public forms 4 | Permission/codec fallbacks, true MIME, previews, limits | Device deny/cancel, mixed audio exchange, HEIC/PDF/download |
| Offline draft/storage durability | Dexie tx/outbox; React/debounced drafts | Foundation 1 | Persistence states, lifecycle recovery, quota/export/LWW candidate | Kill after acknowledged save, quota failure, eviction rehydrate |
| Mobile network/uploads/retry | Foreground sync/chunks, WS reconnect | Foundation 1 | Timeouts/backoff, media pending count, lost-ack replay | Network flaps, chunk interruption, failed-file retry |
| Logout/same user/multiple tabs/devices | Cached auth, different-user DB delete | Foundation 1; controls 5 | Protect account-owned pending work; lock old-tab identity | A phone+A desktop, old tab, B login, offline logout |
| SW/cache/update reliability | Precache, immediate activation | Foundation 1 | Safe asset handover, bounded downloaded cache | Partial update/offline old tab; no API cache |
| Touch/stylus canvas / diagrams | Pan/pinch/move/resize; rest planned | 2 | Gesture modes/cancel, list/inspector/connect/frame actions | Real pinch/pen + no-drag equivalents, 300+ items |
| Calendar/timeline | Phase 2 plans | 2 | Agenda/range list with date editors and blocker text | Mobile reschedule/dependency, date-only timezone |
| Dashboards/leadership/project review | Phase 3 plans | 3 | Container-adaptive blocks, metric source drill-down | Phone/tablet same source totals/action paths |
| Field capture/experiment/operational links | Quick capture baseline; context planned | 3 | Recoverable contextual draft, missing-context decision | Offline field log/media→related records on second device |
| Notifications/reminders/preferences | Presence/activity; Inbox planned | 4 | Browser Inbox baseline, optional push, resume reconciliation | No install/denied push, background resume, duplicate reminder |
| Public forms/approvals/automation | Phase 4 plans | 4 | Phone-first labeled forms, retry-safe receipt, action reorder | Unauthed phone, offline/Turnstile failure, approval gate |
| Restricted caches/guests/search/history | All workspace records pulled today | 5 | Identity/permission eviction, mobile search & lease decision | Multi-device revocation, stale cursor/rejoin, no restricted leak |
| AI workflow parity | MCP connector; prompts/digests planned | 6 | Browser deep links/review/summaries, host-independent fallbacks | Phone prompt→preview→document→undo; permissions |
| Responsive regression/performance | Chromium scripts + selected phone cases | 0–6 | §9 local multi-engine suite + physical devices | Phase report distinguishes passed, failed, not run |

## 9. Reproducible verification strategy

This review adds a **test plan**, not test files, dependencies, test results or a running test environment. Reuse existing npm scripts and installed `playwright` library; prefer a small configurable Node runner over a new test framework unless an implementation phase demonstrates value. Keep tests independent of paid infrastructure or GitHub Actions.

### Viewport matrix (CSS pixels; test height and width)

| Fixture | Viewports | Input and stress |
|---|---|---|
| Narrow / short phone | 320×568, 360×640 | Touch; long strings; 320px reflow; small keyboard-visible region |
| Regular phone | 390×844 | Touch, portrait, light/dark, software keyboard on physical device |
| Large phone + landscape | 430×932, 844×390 | Touch, landscape cutouts, browser chrome, keyboard |
| Small tablet | 768×1024, 1024×768 | Touch + keyboard/trackpad, rotation |
| Large tablet | 820×1180, 1180×820 | Touch, split editor, optional stylus |
| Tablet split/resized window | 512×768, 600×900; continuous resize 500–1100px | Touch/hardware keyboard; preserve route/draft/focus |
| Laptop | 1280×720, 1366×768 | Keyboard/mouse/trackpad, short vertical space |
| Desktop / wide monitor | 1440×900, 1920×1080 | Keyboard/mouse, narrow embedded block containers |

Run 200% text resize, 400% zoom/reflow, reduced motion, high contrast and representative long/non-Latin content. DPR 1/2/3 screenshot checks where relevant; dimensions above are layout fixtures, not promises about named physical devices. Virtual keyboard is a physical-device gate, not merely a shorter desktop viewport.

### Local execution plan for future implementation

1. Create a disposable local test environment with a documented test-only `.dev.vars` SESSION_SECRET and the repo's local D1 migrations. Apply only locally; seed admin/bob through smoke fixtures. Never run bootstrap, CRUD or smoke against production. Use isolated state/profile directories for suites; validate any cleanup targets and preserve unsynced personal work.
2. Run existing `npm run typecheck`, `npm test`, `npm run build`. Serve the **built app** with `npx wrangler dev --port 8788` in that environment, not Vite, for SW and WebSockets. On the fresh disposable fixture, `bash scripts/smoke.sh http://localhost:8788` uses its positional base argument (default is :5173); it expects bootstrap state and seeds admin/bob plus remaining test seats. Do not rerun bootstrap against personal state. Existing verify scripts vary in arguments; consolidate a BASE_URL convention during implementation, do not assume every script accepts the same flag.
3. Install Playwright's matching engines locally with `npx playwright install chromium firefox webkit` (Linux may require OS dependencies). Planned runner: `node scripts/verify-platform.mjs --base http://localhost:8788 --engine chromium|firefox|webkit --profile desktop|phone|tablet|matrix`; **this runner does not exist yet**. Scripts import `playwright` today; no assumed `@playwright/test` or new package requirement. Host OS may limit available engines; report skipped coverage and run on another developer machine rather than marking it passed.
4. Run full layout matrix in Chromium, core CRUD/editor/offline/overlay scenarios on all engines at 390×844, 820×1180 and 1280×720, and targeted failure/regression cases on affected engines. Firefox uses viewport-based compact-layout tests without unsupported isMobile emulation. Use supported touch emulation where available; never rely on Chromium CDP for Firefox/WebKit assertions. Multi-touch fidelity remains a real-device check. Browser-blocked permissions/clipboard/SW paths need explicit tests.
5. Use independent browser contexts/devices for A/B users and same-user A/A replicas, unique data ids and eventual condition assertions (not fixed sleeps). Create page/block/database/record/relation/dependency offline → reload → reconnect → assert server state and second replica. Different-field merge and same-field LWW including AI conflict must be checked separately. Lost acknowledgement, rejected writes, expired auth, invalid queue entry, upload retry and interrupted complete have deterministic failure injection on local fixtures.
6. Record screenshots per engine with stable seeded content/fonts, after readiness assertions. Check root overflow, overlay bounds, target sizes, readable wrapping and focus positions; snapshot diff alone is insufficient. Mask clocks/presence and transient animation. Trace failed flows, keep console/page errors and machine-readable results; redact tokens/credentials. Add optional open-source accessibility scanning if needed, but keyboard/manual AT tests remain mandatory.
7. For real devices, use an already-authorized disposable HTTPS test origin or a locally trusted HTTPS endpoint on LAN. Desktop localhost is a secure-context exception; plain LAN HTTP is not sufficient for camera/mic/SW. Provisioning a staging Worker is a separate authorized task; no tunnel/deployment is required or performed by this review. Record cert/origin and exact builds; no paid device cloud needed.

### Scenario inventory and physical-device checklist

| Suite | Reproducible scenario / pass evidence |
|---|---|
| Shell/auth/accessibility | No-install sign-in, password manager/paste, empty/offline/error/retry; drawer/tree/search/create; keyboard order, dialogs/restoration, Back, safe areas, 320px no root overflow; VoiceOver/TalkBack/NVDA announces names/states. |
| Editor | Soft-keyboard multiline paste/selection/IME/autocorrect/dictation; slash/mention tap; nested page + block insert/reorder/media/checklist; undo/redo; long-document scroll and keyboard-visible toolbar; remote edit while focused; reload after local acknowledgement. |
| Database workflows | Create database/record/field/view; edit every property; filter/sort same result ids across presentations; relation add/remove/replace/inline create; sub-record parent/depth; dependency direction/cycle; status/order via actions, bulk selection. |
| Canvas/dates | Touch pan/pinch transition/cancel, precise resize inspector, keyboard/list alternative, connect source/target, frames/diagram list, rotation and pen; agenda/timeline date edit and blocker list; public read-only equivalents. |
| Media | Native camera/gallery/file chooser cancel/deny, portrait orientation and large HEIC/JPEG; unsupported photo/video/PDF fallback; Safari-recorded audio plays on Android/desktop and vice versa, MIME/name verified; mic interruption; transcript pending/failed; 20MB rejection; upload resume and byte integrity. |
| Reliability | Airplane mode, unstable connection, lock screen, app switch, close/reopen and tab discard; same user phone/desktop + second user; unacknowledged vs locally saved distinction; quota denial/private-mode exit; simulated eviction, safe cache/update, pending logout/account change. |
| Phase surfaces | Small-screen preview/conflict/undo, dashboard drill-down/field capture, public form retry/server receipt, notifications/approval/automation, permission revoke/search/history, AI-generated document/suggestion links. |
| Performance | Fixed local fixture: 1,000 records with 12 fields, 200-block long document, 350 canvas items (Phase 2), 10 photo attachments. On a named lower-powered Android device measure cold/warm/offline open, input responsiveness, scroll/pan stalls and memory. Initial budgets: local action feedback ≤100ms, settled local edit/view update ≤200ms p95; target LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 on documented network/hardware. These are targets, not current measurements. Inspect >50ms tasks and unbounded blob/DOM growth; store traces and tune fixture/budget with measured evidence before phase acceptance. |

Playwright WebKit is an engine test, not shipping Safari/iOS verification [S19, S20]. It does not validate real software keyboards, Pencil, camera picker, OS codecs, push, background suspension or Safari eviction. Simulated offline/eviction establishes recovery logic, not a guarantee of real storage persistence. Real Windows/macOS branded browser and Android/iPhone/iPad checks are release gates for affected workflows. If hardware is unavailable, document the missing gate; feature completion cannot be inferred from Chromium alone.

## 10. Cross-platform Definition of Done (every phase)

1. Map each delivered operation to expanded/medium/compact and keyboard/touch paths. New shared primitives pass §4/§6; preserved prior features pass focused regression. Optional capability denial still offers the required fallback.
2. Phase-specific scenarios pass Chromium, Firefox and WebKit; compact/tablet/desktop screenshots and functional assertions agree. Record exact versions, base origin, fixture and commands. Required physical-device and screen-reader gates pass or remain explicitly incomplete; do not declare cross-platform completion with missing gates.
3. Local save, pending metadata, pending/failed bytes, server-only actions and errors are distinguishable. Offline/reconnect, same-user multi-device, suspended/reopened browser and applicable permission/security cases have evidence.
4. No installation is needed; no hidden hover/drag/shortcut-only operation, unhandled permission/codec failure or keyboard-covered action. Low-powered-device budgets are measured for new heavy views/media operations.
5. Report implemented vs planned vs unsupported/fallback vs not tested. Update the support matrix when verified behavior changes. All existing phase-specific data/security tests still apply.

Phase 0 §0.1 alone uses its isolated identity regression and must not wait for platform retrofits. Full Phase 0 additionally checks its new auth/review surfaces and inventories remaining foundations for Phase 1/2; this exception does not constitute whole-product platform sign-off. Phase 1 sign-off closes the named non-canvas foundation gaps in §2/§8. Phase 2 sign-off closes canvas gaps. Phases 3–6 apply all foundations and cannot defer parity to a later polish phase.

## 11. Architecture decisions and unresolved risks

| Decision | Reason / consequence |
|---|---|
| Browser-first, one responsive codebase | Existing stack supports shared CRUD/sync and routes; native projects would duplicate logic and violate normal HTTPS access. |
| Optional PWA | Useful caching/launch/share enhancements without excluding browsers or making iOS push a core dependency. |
| Functional parity with adaptive interactions | Sheets, list/agenda/inspector and action alternatives preserve operations at small sizes; desktop density does not dictate touch controls. |
| Capability detection + progressive enhancement | Permissions, engine/OS variants and restrictions are tested where used; core never requires experimental APIs. |
| Honest local-first reliability | Dexie transactions/outbox remain foundation; recovery and visible pending state replace unfounded background/durability promises. |
| Existing phase graph and low-cost Cloudflare services retained | Foundations attach to feature delivery; identity fix stays first; no new eighth phase or infrastructure dependency. |

Open questions for implementation planning (not excuses to omit acceptance):

- Inventory actual team devices/oldest supported OS and obtain real-device testing access. The rolling policy is proposed; select exact builds and verify the locked bundle before release.
- Design/test editor beforeinput, inverse patch history, selection restoration and local LWW recovery limits without changing server contracts. Structural undo with intervening remote writes must be explicitly safe.
- Verify WebKit/Firefox media decode/encode and Whisper support with real produced blobs, including modern Safari output; a 2020 MP4 article is not an exhaustive current codec list. Confirm authenticated PDF/video range/download behavior from Worker routes and choose fallback on device.
- Measure partial attachment transactions, large-image memory, cache budgets, concurrent tabs and stale SW asset handover. Recovery/export must never carry tokens or expose another user's retained work.
- Decide Phase 5 offline permission lease/freshness, shared-device retention and rejected-edit export policy with owner; disconnected cached access cannot be instantly revoked. Server filters/eviction feed require the existing Phase 5 design review.
- Public form retry deduplication, draft retention/privacy and Turnstile accessibility need concrete Phase 4 detail. No background submission without an explicit server receipt.
- Caption/transcript authoring and inaccessible third-party embed alternatives need content policy and real AT verification; automated transcription cannot establish accuracy/conformance.
- Confirm host-specific mobile OAuth/connector/embedded AI support before Phase 6 integration; required browser review/actions remain in Workspace regardless of host enhancement.
- Safari sticky/overflow/transformed overlays, input zoom, selection and toolbar behavior need current device repros. Prefer conservative layout fallbacks; don't invent universal Safari workarounds from historical bug reports.

## 12. Verified external references

Checked 2026-10-08 using official standards, vendor/developer and browser-reference documentation. Version-sensitive behavior must be rechecked during implementation. No claim of device testing follows from these references.

- **S1** [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) — origin quota, best-effort/persistent modes and origin eviction.
- **S2** [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) — private mode and browser storage behavior.
- **S3** [MDN: Installing and uninstalling web apps](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing) — installation differences.
- **S4** [WebKit: MediaRecorder API](https://webkit.org/blog/11353/mediarecorder-api/) — MIME probing and historical MP4 support; not a current exclusive-format contract.
- **S5** [Chrome: Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) — freeze/discard and lifecycle limits.
- **S6** [Chrome: Viewport resize behavior](https://developer.chrome.com/blog/viewport-resize-behavior) — keyboard visual/layout viewport distinction.
- **S7** [MDN: Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API) — limited availability.
- **S8** [MDN: Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API) — user gesture/permission differences and deprecated execCommand.
- **S9** [MDN: VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API) — progressive viewport observation.
- **S10** [Tailwind: Compatibility](https://tailwindcss.com/docs/compatibility) — dependency floors and optional CSS support.
- **S11** [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) — HTTPS and lifecycle/cache model.
- **S12** [MDN: HTML capture attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture) — limited camera-selection hint.
- **S13** [MDN: getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) — secure context and permission requirements.
- **S14** [MDN: MediaRecorder.isTypeSupported](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static) — actual recording can still fail.
- **S15** [W3C: Pointer Events](https://www.w3.org/TR/pointerevents3/) — touch-action, capture and cancellation.
- **S16** [WebKit: Web Push for iOS/iPadOS web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) — Home Screen push constraint.
- **S17** [Apple: Alternative browser engines](https://developer.apple.com/support/alternative-browser-engines/) — regional engine policy; no universal brand→engine assumption.
- **S18** [W3C: WCAG 2.2](https://www.w3.org/TR/WCAG22/) — normative AA requirements and exceptions.
- **S19** [Playwright: Browsers](https://playwright.dev/docs/browsers) — supported engines/branded browser options.
- **S20** [Playwright: Emulation](https://playwright.dev/docs/emulation) — device/viewport emulation scope.
