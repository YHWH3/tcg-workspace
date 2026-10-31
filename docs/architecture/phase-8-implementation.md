# Phase 8 implementation

Branch `sol/p8-desks` stacks on Phase 7. Phase 8 is in progress; no operating
desk acceptance is claimed yet. The attention implementation is described below. Owner decisions D4–D6
are recorded in the roadmap. Item 8.0 precedes application work.

## 8.0: resumable certification

Implemented and accepted at `6f8a1c3b18e938f68f718383e4b51aefdb489925`.
[Source-bound evidence](../roadmap/evidence/P8-8.0-6f8a1c3.json) records the
simulated post-D1 pause and the complete resumed certificate: 34/34 mandatory
gates PASS, exit 0. Seven gates were reused after checking source, clean trees,
mode/permission contract, exact runtime versions, freshness and sealed SHA-256
artifact hashes. Reuse avoided 34.7608 minutes of original gate execution.
Unit 1644 and dedicated D1 732 counts overlap; harness 138 checks passed.

The orchestrator owns its five-second monotonic heartbeat and detects gaps over
90 seconds. A host pause interrupts the active gate and writes a resumable
PARTIAL summary. `--keep-awake` uses process-scoped macOS caffeinate; lid closure
can still suspend the host. `--resume` creates a new certificate and never
changes the source certificate. Freshness/security, dependency/lockfile,
source-integrity, browser and performance-evidence gates always rerun.
Performance evidence is recomputed from verified copied unit/D1 artifacts.
Failed, incomplete, interrupted or previously reused gates are not reusable.

The demo deliberately used a fresh pair after the user's earlier pause during
D1, so both unit and D1 were fresh in the same source certificate. The earlier
user-interrupted report remains untouched. The successful controller verified
the entire original certificate's hash inventory was unchanged after resume.
Reports, ledger and future PR text must explicitly say **resumed**.

This is tooling-only: no application code, migration, synced data collection,
MCP contract or permissions activation changed. The certificate is bound to
6f8a1c3; subsequent documentation commits do not change its tested identity.
New Phase 8 application work requires its own focused checks, browser coverage
and final phase certification. Physical hardware, human screen readers and
actual human acceptance remain external gates. No deployment or real-provider
operation took place. Usage is in [CERTIFICATION.md](../testing/CERTIFICATION.md).

## 8.1: attention queue

Implemented in the containing commit; final Phase 8 certification remains pending.
The collector derives the queue from existing operational tables and records.
It creates no synced collection or server queue. The same bounded collector serves
`GET /api/attention`, the read-only `attention_queue` MCP tool and attention blocks
in `dashboard_snapshot`. `triage_my_attention` is an answer-only assistant action;
it cannot approve or execute a change.

The collector supports owned approvals/previews/suggestions, assigned dated work,
configured unassigned triage, unread mentions and admin-visible automation failures.
Website response aging is added in 8.3. Candidates are capped per source and one
canonical read decision gates their metadata. Current authority and revisions are
checked again before returning. Private titles, answer bodies, old notification
copies and provider errors are not fetched for display. Own restricted approvals
and mentions are redacted. Cursor bindings include the account, connector,
workspace day/settings, permission mode and selected kinds. All source limits are
reported explicitly; urgent counts describe bounded candidates, never a guaranteed
workspace total. Tests assert a maximum of 12 D1 binding calls per collection.

The `attention` page block supports 5/10/20 items, source selection and compact/full
rows. Native links open existing approval/review screens. Record actions re-read
local sources, derive only the current configured field/stage and use `mutate()`
with retained source guards. Approval-gated moves use the existing request dialog
and server guard. A local save is labelled separately from server acknowledgement.
There is no completion action for a records database without stages.

Snapshots live in the account's Dexie `meta`, bound to a hash of the session token
and the reconciled access version. The token is not persisted in the snapshot.
Delayed cache/network work is discarded on account, session or access changes;
authority failures clear visible source content. Temporary failures retain a
labelled snapshot. Offline access uses the existing reconciled-cache contract and
does not promise immediate offline revocation. Live hints refresh after two seconds;
reconnect, visibility and workspace-day changes also refresh. No authenticated API
response is placed in the service-worker cache.

Both database shells offer an Attention settings sheet. Task databases keep their
existing assigned/due defaults; records databases opt in. Operating Pack v3 adds
missing settings for Opportunities (Owner + Next action date), Decisions (Decision
maker + Date), and Media (Owner + Publish date), using verified field IDs. The
single-date configuration does not imply an additional deadline fallback; the
funding desk provides deadline views later. Reviewed upgrades retain team settings,
including explicit null/disabled values, and refuse incompatible changed field
types. Template copying preserves attention options. New Website inboxes default
to all-admin triage; signed ingest adds a missing legacy setting in its existing
revision-fenced board mutation, preserving a team opt-out.

Typecheck and 179/179 focused checks across 18 files pass, as do the three compact
Chromium browser workflows; the 18-project
attention matrix is the next acceptance step. Earlier failed probes are retained
locally. They found a checkbox controlled-state delay (fixed with an immediate
configuration draft) and a legacy-ingest revision conflict (fixed by combining the
missing setting with the existing board mutation). Navigation-helper regressions
also preserve blocking for unacknowledged writes and current-document stalled reads
while retiring only the captured old-document reads after hard navigation.

The first complete attention-only matrix at `79c931b` is retained as failed. It
exposed a comment badge overlapping Configure at tablet/desktop sizes; Attention
now uses dashboard comment placement and page context classification. The fixture
also verifies that unrelated Website triage remains after its own records clear,
rather than incorrectly expecting a global empty queue. A fresh matrix is required.

The second complete matrix at `64e580f` retained 45 passes and 9 failures. Offline
light-mode shell text failed contrast (2.08:1); status colours are corrected.
The navigation harness now also captures old-document reads started between a
hard-navigation request and its document commit, preserving current-document and
write blocking. Focused tablet light/dark workflows pass. The settings sheet now
validates its numeric input accessibly, retains its original source guard during
editing and lets operators remove disabled/unavailable selected triagers. A fresh
complete attention matrix is still required before accepting this correction.

All 54 browser cases and the fresh 179 focused checks passed at `3aff4db`.
Screenshot inspection nevertheless found a compact enlarged-text Page menu only
46% visible. A new intersection/inner-scroll-width regression reproduced it.
The page toolbar now wraps and keeps every action within its page width; targeted
compact Chromium and WebKit checks pass. This visual finding requires another
frozen browser matrix, not a waiver based on the previous automated PASS.

The fourth matrix retained 48 passes and 6 failures: the added inner-page
reflow assertion exposed enlarged tablet overflow after Page-menu visibility was
fixed. Sidebar width now keeps its normal 15rem and caps at 35vw, leaving usable
content space when root text grows. Default compact/tablet/desktop widths are
unchanged. Targeted tablet Chromium/WebKit checks pass. The final selection also
reruns the existing inbox/task text-enlargement case (72 total browser cases).

Feature verification is now accepted at `870e8a2`: 72/72 final browser cases pass
with no skips, unexpected failures or flaky outcomes. The selection includes all
54 attention cases plus the existing 18 inbox/task text-enlargement cases.
[Exact source and evidence](../roadmap/evidence/P8-attention-870e8a2.json) preserve
all earlier failures and the 179-test focused result's original source. This is
feature-level evidence; the rest of Phase 8 and its final certificate are pending.

## 8.9: reliability on this device

Implemented in the containing commit; focused verification passes, matrix and
Android qualification are pending. Settings > Local data always shows Reliability;
existing permanent local-store deletion remains a separate explicit confirmation.
A warning chip links root pages/Home and the sidebar to this panel for failed,
held/rejected or old pending work. No server endpoint or schema migration is added.

The panel separates pending record changes, rejected changes, held operations,
pending/active/failed uploads, observed push/pull times, network interface and live
connection. Names come from current file metadata; snapshot reads use blob index
keys/counts and never materialize attachment bytes or held payloads. Names are
limited to 20 with explicit truncation; counts cover the local queue. Missing or
legacy ages are labelled unavailable instead of invented. New writes retain an
enqueue time independent of their logical edit timestamp.

A successful validated push with acknowledged entries records its timestamp in
the same Dexie transaction that removes those entries. Refused, malformed, lost
or empty push responses do not manufacture a receipt. Successful pull observations
are separate; account/access changes abort these writes. Old account copies are
ignored. Observed times do not imply that all work, media or other devices synced.

Retry failed uploads is an explicit, bounded, identity/access-fenced transaction.
It preserves chunk progress and original bytes; missing metadata, deleted files
and missing-byte placeholders remain failed for recovery. The existing uploader
performs normal server checks. Runtime uploading is an ephemeral account-bound
store cleared in finally, not a durable state that can survive a crash falsely.
Review held work uses the existing metadata-only dialog. Rejected-item export
reuses the retained serializer and is account/session/access fenced; it never
includes held payloads. No automatic discard or provider operation is added.

Focused checks: 107/107 across ten files covering reliability, real client sync
ordering, media, transaction rollback, reconciliation, attention/pack client
regressions and popover placement; typecheck passes. The
three compact Chromium workflows pass, including offline edit -> server receipt,
forced 507 -> retained bytes -> explicit retry -> identical server bytes, and
held-review/rejected-export separation. Earlier failed probes were fixture
selector errors and remain retained. Three-engine matrix and the new opt-in
`--reliability` Android upload-recovery journey still need execution. Emulator
results must remain distinct from physical-device or human acceptance.


Reliability verification also reproduced existing shared-surface defects: footer
account menus could open outside the viewport in Firefox, Settings/notification
captions failed contrast, and fixed-width notification rows overflowed compact
Settings at 200% root text. Popovers now flip/clamp using measured content size
and react to resizing; the legacy footer positioning classes are removed.
Captions use established readable light/dark tokens and notification controls
wrap. The regression uses actual account-menu navigation, not forced clicks.

WebKit refused all Blob/File persistence in the isolated test, including a fresh
memory Blob and the empty failure marker. Staging now tries a bounded ArrayBuffer
fallback in the existing account-local blobs store. `blobCodec.ts` restores the
Blob API for ordinary reads while metadata/index queries avoid bytes. Retry and
chunk progress updates preserve the wire encoding. When access is removed,
`applyAccessWork` retains those encoded bytes in the same quarantine transaction;
its metadata-only review/export rules are unchanged. The original-byte upload
passes after database reopen in unit tests and in a WebKit browser probe.

No index or D1 schema changes are needed. This additive local row format is read
by this/newer client code; older clients cannot decode fallback rows. Keep the
entire account store when reverting local source and use this/newer client for
recovery of pending or held fallback attachments. Do not clear stores to work
around a client-version mismatch. All-byte-storage failures still follow the
explicit failure path and cannot be represented as a successful upload.

The final reliability browser journey requires document reload before retry,
compares the served bytes with the original input and verifies 200% text reflow.
A compact Chromium/WebKit correction probe passes. A fresh 144-case selection
(attention, reliability, existing search and view controls) plus Android emulator
qualification remains pending. Full Phase 8 certification remains pending.


At `15b910e`, the 144-case expanded browser selection passed with no skips or
flaky cases, and the Android emulator suite passed 20/20 checks across three
profiles with confirmed cleanup. Screenshot review then found a tablet footer
account trigger overflowing the sidebar at 200% text. A new boundary assertion
reproduces 359.6px against a 287px sidebar. Popover wrapper/trigger max widths and
the account flex child's minimum now allow the existing ellipsis to work. The
three-engine focused correction passes; feature acceptance waits for verification
on that corrected source. Earlier automated passes remain tied to their source.


The sidebar-corrected source `e2abd61` passes the complete 144-case selection.
A final upload memory regression then demonstrated that the previous `.toArray()`
scan decoded all pending fallback payloads before uploading the first file.
The uploader now scans index keys and materializes one pending payload per
iteration, preserving identity checks, retained chunk progress and serial retry
behavior. A fresh full reliability selection and Android qualification must
verify this change; the wider UI/UX source is unchanged from `e2abd61`.


At `ebed3b2`, the final 54 reliability browser cases and 108 focused tests pass.
Native qualification retained an ADB-offline attempt (graphics-buffer error
observed, cause unconfirmed), followed by a diagnostic 20/20 PASS. A subsequent
uninstrumented run exposed native keyboard readiness in the rotation harness.
It now adopts the visible Android VIEW-intent tab before claiming native IME
interaction, and wraps all offline injection in cleanup. This matches the
existing task/assistant native workflow approach; no keyboard, persistence,
rotation, background, upload or service-worker assertion is removed. Browser
application and UX-lab sources remain unchanged. Native acceptance is pending.


Item8.9 feature verification is accepted with exact-source evidence in
`docs/roadmap/evidence/P8-reliability-161619d.json`:108 focused checks, typecheck,
54 reliability cases/18 projects and final Android20/20 with owned cleanup.
The144 wider UI cases retain their e2abd61 source; later upload scanning was
verified by the54 feature cases. Final native source161619d changes only the
harness/docs since application ebed3b2. Full Phase8 certification remains pending.


## 8.11: AI review desk

Feature evidence: `docs/roadmap/evidence/P8-ai-review-a003513.json`. Full90
browser cases,67 focused tests, two fixture-boundary checks and typecheck PASS
at a003513. Existing Phase6 suite42/42 PASS at41852d1 (only test navigation
and ledger changed). Six screenshots reviewed; final phase certificate remains
pending. `/ai` opens Review, with a link to the preserved Workflow library,
deterministic weekly digest and provider configuration. Review groups active
proposals with a once-per-second expiry label, approved/executing proposals with
Resume / Review links, existing pending suggestion editors, and recent changesets
with links to `/ai/undo/:id`. Recent completed/cancelled proposal results remain
available in a disclosure. The current endpoints cap windows at50 proposals,
100 suggestions and50 changesets; the UI labels capped windows and never claims
workspace totals. An executing proposal can contain committed work or a source
conflict; the existing detail screen rechecks it before execution. No new approval,
mutation, schema or paid inference path is introduced.

`useAiReviewRead` uses an in-memory read controller that discards superseded,
unmounted, account/session/access-changed results. Refresh/failure clears prior
content; errors do not become empty lists. Online/current-access wrappers hide
Review and Undo immediately offline. Focus/live/visibility events refresh metadata.
Attention links target the matching proposal or suggestion in this desk; anchor
focus runs only once per hash to avoid stealing focus during refresh. Significant
writes remain session-approved and fenced by the existing server paths.

Browser probes exercise raw MCP proposals (no automatic fixture approval), actual
session browser decisions, source change after approval, refused execution,
rejection/cancellation, edited suggestion acceptance and revision-safe undo,
expiry, loading/failure, offline concealment, library recovery and200% text.
Existing AI screens lacked an inner scroll region within the clipped shell;
Review, detail and Undo now own a full-height scrolling region. First failures
are retained. The OAuth helper opts into TLS only for an exact loopback origin
with raw review mode, preserving previous HTTP/default fixture behavior. Native
emulation, genuine human acceptance and final Phase8 certification remain distinct.

## 8.3: Website response desk

Feature engineering evidence is recorded in
`docs/roadmap/evidence/P8-website-desk-c38f87b.json`. The existing Website
section adds Unassigned, Mine, All open and Follow-up due queues, family and
response-age filters, owner/date/status actions and bounded sequential bulk edits.
Undo uses field preconditions and refuses changed values. Local saves and server
acceptance remain separate; status gates use the existing approval dialog through
a module slot. Reply drafts remain in component memory and are copy-only, with a
clipboard-denial fallback. They never send email or mark a reply when copied.

Shared figures use the received calendar date, falling back to createdAt in the
workspace timezone, with unknown dates explicit. Board keys responseBands and
responseTargetDays configure the default0–2/3–7/8+ bands and3-day target without
a migration. Dashboard, Website MCP digest and weekly deterministic digest share
these figures. Website query filters queues before pagination; triage proposals
can assign active users and follow-up dates through existing browser-approved
previews. Answer continuation and untrusted-source requirements remain intact.

The bounded attention collector adds overdue first replies for their owners or
configured unassigned triagers, and severity2 refund-needed items. Projection is
metadata-only, permissions are checked canonically, and the existing12-call
collector budget remains tested. Stored malformed targets use the same default
in SQL candidate selection and shared figures, so the cap cannot hide overdue
work. No new collection, mutation endpoint or ingest contract is introduced.

Nine development browser cases pass after retained failures. Compact200% text
previously clipped the Unassigned caption; a measured assertion now checks the
selected caption against usable width. Shared record details now stack properties
inside narrow containers, improve label contrast and use the existing sheet
instead of squeezing a database beside a fixed detail pane. The disposable
protocol3 fixture explicitly configures the existing auto-wi-first-reply rule;
permission-enabled clients intentionally do not recreate legacy seeds. The
browser test verifies the resulting first-reply date, not only the status change.
An installation needs that existing rule configured and enabled to stamp dates;
the desk does not recreate intentionally deleted or disabled automations.

The full198-case selection passes at c38f87b across18 engine/size/theme
projects, zero skipped/flaky. The64 focused tests and typecheck pass on the
byte-identical precommit d0bff8d tree. At8f8aea0, the additional9-test real-D1
group verifies combined weekly digest parity in both permission modes; existing
Website UI9/9 and Phase6 enabled-permission42/42 pass with providers disabled.
Application sources are identical across these revisions. Only the fixture's
explicit8-day-old event, assertion of both attention reasons, D1 assertions and
ledger differ. Three final-source200% screenshots cover compact/tablet/desktop.

The first198-case attempt remains interrupted after59 passes, six failures,
one interrupted case and132 not run. Its six completed failures all matched two
valid attention rows by title: existing Unassigned plus new First reply overdue.
The corrected assertion requires both distinct labelled reasons. Invalid-target
and caption baseline failures, the missing-automation fixture attempt and the
earlier user-interrupted focused run remain retained. None is relabelled PASS.

Raw fixture data and failures remain local. Native Safari/Android qualification
for this desk, physical hardware, human screen readers/native zoom, independent
acceptance and the final full-phase certificate remain explicitly incomplete.
Next item is8.4 Project review cockpit; no release/deployment decision is implied.

## 8.4: Project review cockpit (implementation in progress)

The new `shared/projectHealth.ts` calculator explains blocked stages, incoming
unfinished dependencies, missing owner/dates, overdue tasks, open decisions,
participant-visible pending approvals and stale activity. Partial evidence is
Unknown; owner/approval/activity notices do not invent additional risk scores.
Named terminal stages retain Projects/Decisions pack semantics.

The authenticated `/api/project-health` reader and MCP `dashboard_snapshot` /
`operating_review_context` use one bounded collector. It loads named roots,
relations, descendants, incoming blockers, latest authorized activity and only
approvals requested by or assigned to the caller. It projects metadata, not body,
notes or file bytes. Current principal/access/connector fences apply before
publication. Caps and changed owner/date schemas remain explicit. Actual-D1
checks cover both permission modes, private sources, late disablement, relation
filters and a 520-child source cap; all calls remain within the 45-binding budget.

The registered `projecthealth` block uses normal configuration and shared view
filters, source-linked cross-database drills, guarded owner/date writes and
explicit loading/error/offline/recovery states. An offline device snapshot has
no cached server approvals and stays Unknown. In-memory read generations are
account/session/access/config bound. Connection changes replace read evidence
while preserving unsaved edits in that same account generation. Record changes
remain normal local `mutate` writes; server sync is separately acknowledged.

Projects record details use the existing task-detail slot for a derived `self`
panel without silently rewriting bodies. Any saved health block, including a
tombstone, suppresses the default. Customize/Hide explicitly save a deterministic
body block/reservation. MCP derives the same default. Pack v4 adds one stable-key
self block to Project Review; the template copier preserves configuration and
live references without pulling another database merely for health. Record
conversion has a narrow validated self-health exception, bound to its destination.
Existing team content, deletions, title, order and settings remain authoritative.

Focused implementation run: 100/100 across ten files and typecheck PASS in
`.artifacts/phase8/project-health-focused-10.log`. It includes frozen conversion
plans, labelled disposable session decisions, exact execution/replay and existing
preview/conversion regressions. A corrected three-engine probe passes15/15 in
`project-health-three-engine-2.log` (Chromium compact/light, Firefox tablet/dark,
WebKit compact/light). These are preliminary working-tree results; final source
certification has not run. Pack reference validation PASS
in `project-health-pack-validation-2.log`; the old validator omitted existing
attention blocks and internal archived filters. The first browser probe retained
9 PASS / 6 FAIL across three selected projects. It exposed a missing dashboard
classification: comment overlays obscured Configure in Firefox. An empty-body
placeholder also failed contrast. Both are corrected; the unchanged whole-page
accessibility and real pointer assertions pass in the15-case corrected probe.
Earlier schema-drift regressions reproduced before the correction (3 FAIL /
18 PASS); all three pass in the 67-test run. No feature certificate, native or
human acceptance is claimed. Full final-source browser/workflow evidence and the
phase certificate remain pending. No migration or integration-event change.

The first clean-source306-case selection at `0e6b68f` was stopped after83 PASS,
3 FAIL,1 INTERRUPTED and219 NOT RUN. Whole-page checks found low-contrast empty
Linked groups/Link control in light tablet/desktop record sheets, plus a faded
Block options text control at desktop width. The original report remains at
`.artifacts/ux-lab/2026-10-29T06-49-58.499Z/summary.json`; it is not certification.
Linked group labels/counts and the Link control now use readable light/dark
colors. Block options stays visible, has readable text and a32px target. The
unchanged failing journeys pass12/12 across tablet/desktop light in all three
engines (`project-health-contrast-corrected.log`). Fresh committed-source focused
checks, the full306 selection and preserved workflows are still required.

The corrected306 selection at `008225a` completed305 PASS /1 FAIL, no skips or
flaky retries (`.artifacts/ux-lab/2026-10-29T06-57-54.065Z/summary.json`). The
Firefox desktop offline-save case timed out after a health refresh returned a
complete-looking empty list. A controlled actual-D1 test reproduces exactly that
result when the root revision changes between selection and authorization
(`project-health-revision-race-baseline.log`,1 FAIL). The health collector now
reports readable-but-changed source rows as an explicit `project_sources_changed`
HTTP409 instead of silently dropping them. Normal canonical access denial remains
redacted. The browser retries this read once only while its account/access
generation is current; repeated races and network/auth/server failures surface.
MCP receives the source-change error. Wrong-collection database ids are explicitly
unavailable. No write retry, weaker authorization or new binding call is introduced.

Twenty-four focused checks (including real HTTP409, both permission modes and
one-retry/error/context boundaries) pass. A working-tree15-case three-engine
probe passes with the strengthened simulated409 recovery assertion and the
original offline/concurrent-edit assertions. Cleanup skips an already closed
browser page so it cannot replace the original failure with a cleanup error.
The first retry-test mock accidentally returned its mock as a beforeEach cleanup;
that harness failure remains retained and the callback now returns nothing.

Next: clean committed-source107 focused checks and90 cockpit cases across all18
projects, followed by preserved MCP Phase3 and Phase6 workflows. The216 shared UI
cases from the completed008225a selection remain separate unchanged-code evidence;
the old failed306 run must never be relabelled a single-head306 PASS. The full
Phase8 certificate still requires the remaining roadmap items and all mandatory
checks on its final source.

#### 8.4 visual follow-up

The575a7f0 source passed107 focused checks,90 cockpit cases across18 projects,
64 preserved MCP Phase3 checks and42 Phase6 workflows. Screenshot review remained
open. Captured queue metadata showed fresh pending entries and no rejections or
held work. A hook-level regression with real Dexie rows reproduces use of the
mount/periodic clock for a new reactive read: the entry appears to be in the future,
so attention becomes true. Reactive reads now use current observation time while
the interval still schedules aging. The regression verifies both fresh pending
and genuinely aged attention. A browser check holds a real edit before acceptance
and verifies pending behavior, server receipt and queue removal after release.

At200% text the shared DashBlock heading was also visibly truncated. Its redundant
flex spacer competed with the heading; remove that spacer when a heading exists
and allow wrapping. Measured compact/tablet failures now pass, with explicit server
acknowledgement of configuration add/remove, empty/error/409 recovery and separate
cockpit/action screenshots. The corrected three-engine probe passes3/3. The first
probe had an incorrect heading selector and was interrupted; later WebKit capture
positioning was corrected by scrolling the actual Refresh control into view.
Those failed/interrupted reports remain retained. Fresh committed-source focused
and affected browser matrix evidence is still required. No migration, event-body
change, production or human/physical acceptance.

#### 8.4 title-level reflow correction

The3348780 source completed120 focused tests,378 selected browser cases and the
64/42 preserved workflows, all clean and source unchanged. Final screenshot review
found another visible condition: Firefox200% renders a long Project link outside
its card even though a clipped ancestor keeps document.scrollWidth unchanged.
A new title-level width assertion reproduces442px text inside201px. The link now
uses normal wrapping text flow rather than an anonymous flex text item. Corrected
three-engine probe3/3 PASS; this is the only application change after3348780.
The mandatory UX catalog also names the already executed fresh-edit regression.
Run fresh120 focused and90 affected cockpit cases on the new committed source.
Keep the288 unrelated cases and64/42 preserved workflows tied to3348780; do not
claim a new-head378 pass or visual acceptance from the old page-overflow assertion.

#### 8.4 final source-bound feature evidence

At `1b4aceede75018050b3bfa95e47a253dcc2b1eb0` (tree
`dcad61cd37b859e60d8a065dd47a7a9ada15f257`, fingerprint
`df545a869c8b5f74cc441c6faea9e184af90b733eca61ebaa21cc5084c77b0f8`),
clean120 focused tests/14 files, typecheck, pack validation and90 cockpit cases
pass,18 projects, no skips/flaky/retries. The final title assertion measures the
actual link as well as document overflow. Six final200% screenshots were reviewed
across Chromium compact/light, Firefox tablet/dark and WebKit desktop/light.

The broader378 selection at3348780 passed; its288 non-cockpit reliability/pack/
shared UI cases remain separate unchanged-code evidence. Preserved MCP Phase3
64/64 and Phase6 42/42 also passed at3348780. The only later application difference
is Project health link display; worker/shared/template code is identical. Do not
claim a single-head378 PASS. Source hashes, commands, artifact hashes, platform
matrix, retained failures and limits are in
`docs/roadmap/evidence/P8-project-cockpit-1b4acee.json`. Providers stayed disabled;
automated session approvals were disposable fixtures. UX used owned loopback
HTTPS, preserved suites owned HTTP; no global trust change.

Only sanitized docs/evidence follow verification. This is feature engineering
evidence, not a final Phase8 certificate or native/physical/human acceptance.
Continue with8.5 Funding and finance in the roadmap's dependency order.

## 8.5 Funding and finance desk (implementation, final evidence pending)

The new shared finance calculation uses configured numeric/type/relation fields,
including the primary-normalized reverse Transactions relation. Signed negative
expenses/income reverse only their own subtotal. Budget line rows are planning
values and do not count as actuals. Remaining is budget minus net expenses;
income is shown separately, never added into budget again. Effective currency is
a field override or workspace setting; mixed currencies return an explicit error,
with no exchange conversion. Integer minor units avoid binary-fraction accumulation
and unsafe sums are refused. Unknown amounts/types and missing budgets remain
explicit; known deleted/archived transactions are excluded in both permission
modes. Product economics computes Price minus Cost and percentage only for positive
Price, while preserving the existing text Margin field.

The Worker collector projects only money/filter metadata, caps roots/relations/
records/databases and uses the canonical read gate, sponsor/session context and
final observed-authority fence. Its source revision check also works with
permissions disabled. HTTP and dashboard_snapshot share the same calculation;
MCP supports Products database context and combines budget and Project health
under the invocation budget. Local indexed sources are always a partial device
snapshot. Current-context read conflict gets one retry; repeated races and other
failures surface. The budget UI has source records, exact transaction drills,
configuration, empty/loading/error/recovery and mixed-currency states. Products
can open the same content through a databaseSummary slot, without silently
persisting a block. No database/accounting/feed/reconciliation system is added.

Packv5 adds stable stale next-action filters (2000-01-01 through today-1; exclude
won/lost, retain dormant), project budgets on Finance/Finance Review, current-record
budget on Project Review and Common Cupboard economics. Template copies retain
live money references instead of copying related databases. Conversion copies
only validated self-budget configuration bound to the destination, through the
existing frozen preview and disposable session-approved execution. explain_budget
is a read-only contextual prompt; it is not a new MCP tool or provider inference.

Working-tree focused73/73 tests across9 files PASS; corrected9-case three-engine
probe PASS (Chromium compact/light, Firefox tablet/dark, WebKit desktop/light).
Earlier results remain retained: initial25 calculation/D1 checks; stricter deleted-
transaction test exposed mode differences, corrected to active totals; pack
validator rejected the existing within operator and now recognizes it. Screenshot
review found a button spilling beyond its card at200%; new geometry assertion
reproduces right311.5px versus257px boundary. Width constraint and wrapping caption
correct it. A disabled-mode root revision race reproduced200 instead of409;
independent root-to-snapshot revision comparison now passes in both modes.

Final clean-source focused/typecheck/pack, full affected browser matrix, preserved
MCP/Phase6 and source-bound evidence/publication remain pending. No migration,
integration body/secret/env change, real provider/email/payment or production work.


Finance rounding follow-up: a paired expense/reversal of ±1.125 reproduced a
one-cent residual (1 FAIL/14 PASS). Decimal formatting now rounds half units
symmetrically, consistent with displayed currency; ungrouped digits are parsed
into safe integer minor units before summation. Regressions cover1.005,10.075,
exact reversals and zero/two/three-decimal currencies. Corrected calculation and
D1 checks38/38 PASS. The earlier frozen8c7ddf7 selection is INTERRUPTED, exit130:
88 PASS,1 interrupted,271 NOT RUN. Its report remains preserved at
.artifacts/ux-lab/2026-10-29T15-27-52.148Z/summary.json; it is not acceptance evidence.
New committed-source focused and browser verification are required.


At a96c789, clean167 focused/typecheck/pack and360/360 selected browser cases
passed across all18 projects, zero skips/flaky. Post-run review then reproduced
repeated budget blocks sharing one progress ID (1 FAIL). The only subsequent
application change uses a per-mounted-reader ID prefix plus item index, so labels
remain unique even for the same Project in several blocks. The existing finance
journey now checks both IDs and each bar's accessible name. Final54 affected
finance cases, focused checks, preserved suites and screenshot review are pending.
Retain306 unaffected Project/pack/shared UI cases at a96c789; do not claim a final-
source360 PASS. New Products normal/zero-price images supplement enlarged review.


8.5 feature verification completed at3ebba8240547be4b7dc4c4a38f027233a73599e5,
tree2cd9e1714a3f0d7ea877986257dd5c1b612d2468, fingerprint
1cb7d3ca2ef82cf6b9bfcec372a75ff081f9b270f65b40b46b31b69dcf4b5166.
Clean167 focused tests/19 files,typecheck/pack,54/54 final finance cases on all18
projects, MCP64/64 and Phase6 42/42 PASS, source unchanged. The broader360 passed
at a96c789; retain306 unaffected Project/pack/shared UI cases at that source.
No single-head360 PASS is claimed. Nine final images inspected: enlarged card/
button wrapping and Products normal/zero-price states. Screenshots immediately
follow injected server writes and do not assert settled table-sync behavior.
Native zoom, physical devices, human AT/approval and independent acceptance are
not inferred. Exact commands,historical failures,hashes and platform matrix:
`docs/roadmap/evidence/P8-finance-3ebba82.json`. Contract remainsv2, copies identical;
no migration/env/secret change. Only sanitized docs/evidence follow verification.
Phase8 remains HOLD pending8.6 and subsequent items plus final certification.

## 8.6 Field evidence (implementation; final verification pending)

Shared fieldSessions groups the authorized Date/Place/Experiment tuple without
locale-dependent ordering. measurements selects exact trimmed/lowercase units,
refuses mixed units unless a unit is explicitly selected, preserves zero/negative
values and reports missing Date/Unit omissions. measurementLayout scales extreme
signed finite values before subtraction, keeping SVG geometry finite.

The shared normalizer validates untyped configured values once and returns only
metadata, gaps and source links. Neither the Worker nor MCP returns Observation
text or attachment bytes in these summaries: SQL derives its Unicode-trimmed
presence bit. Malformed scalar/object values remain invalid; schema drift,
source caps, inaccessible context and partial device snapshots stay explicit.
A single bounded collector serves HTTP and both dashboard_snapshot blocks under
canonical gates with source-revision/current principal/connector fences. Only
an explicit revision409 gets one current-context browser retry.

fieldsessions lists recent visits with expandable source records and missing-field
fix links. Intentional URL field focus is consumed once after the configured
control mounts, on both record and legacy-task details; normal sync cannot steal
focus. measurechart provides titled SVG, roving keyboard points, original-record
links and a data table alternative. It reports units, dates, ranges and omissions.
The source text stays unchanged; interpretation is separate and no provider runs.

New capture records store captureEvidence v1/photoCount in their initial normal
mutation, before file creation. This is planned photo intent, not upload proof.
Authorized image/file-link metadata can establish evidence availability; older
records retain Unknown intent. Existing durable media refs and deterministic
capture IDs remain the retry authority. Device reliability is linked from both summaries. Gallery/document file handlers snapshot
FileList before clearing inputs; the browser probe exposed deferred reads losing
selected files. The regression forces a local files-write failure, verifies an
initial partial record with intent, restores the staged draft after online shell
reload and retries offline without duplicating record/photo/document. The UX lab
blocks service workers; this does not claim offline shell loading.

Packv6 adds a Field evidence page under Common Lab and stable Field Visit blocks,
preserving team edits and deleted reservations. Copies retain live source database
references and remap copied context IDs; record conversion skips dashboard blocks
through its existing policy. No migration, collection, secret or event body change.
Working-tree failures and corrected results stay in .artifacts/phase8. Final clean-
source focused/browser/preserved checks and visual review are required before
publication. Native/physical/AT and final Phase8 certification remain incomplete.


The interruption probe also reproduced upload sweeping of staged bytes lacking a
file row, causing404 and access recovery failure. Two actual-Dexie upload tests
fail against the original path. The sweep now retains such bytes and skips network
work until metadata exists, while resolving valid deterministic thumbnails through
the canonical owner. It never deletes unclaimed bytes or marks them uploaded.
Full media tests and capture recovery must pass alongside new desk gates.

Capture draft staging now uses the same Blob/ArrayBuffer fallback as ordinary
attachments. The WebKit interruption probe reproduced raw Blob staging refusal;
a cached-byte regression refuses Blob writes and verifies restored bytes. A
known planned photo with capped metadata stays distinct from historical unknown
intent. Missing/null provenance is unknown, while malformed provenance is invalid.

Pre-freeze checks are development evidence only. Four new UX journeys extend the
required catalog to62 cases ×18 projects (1116); final verification selects the
72 new Field evidence cases and affected finance/reliability/shared UI workflows.
The rest of the full catalog and canonical phase certification remain pending.

The first4e28c86 frozen selection stopped with85 PASS,1 FAIL and328 skipped or
incomplete (exit130). The existing tablet offline-editor journey exposed a
transient access-error barrier before the owning sync transport fallback validated
the same cache. It unmounted the editor and rejected its pending text flush. A
real-engine test fails on the old transition. prepareOnlineAccess now leaves
transport errors to syncNow's existing cache validator; it retains any already
raised reconciliation barrier and still fails closed immediately on HTTP denial.
44 engine/media checks and6 original three-engine editor/capture journeys PASS.
No authorization rule is relaxed; stale/required caches and replacement sessions
retain their barriers. Final source-frozen verification must be repeated.


The owner-paused run at f83e190 completed 225 cases; a source-identical resume
completed the remaining 189. Exact-case union validation covers all 414 cases
without gaps, duplicates or retries. Preserve the first report's exit130 and the
resume's exit0; this is not a single uninterrupted run.

Post-run screenshot inspection found N32: long Observation labels forced the
three-column compact measurement table sideways. A new geometry assertion fails
with 324px inside a 290px region. Labels and units now use overflow-wrap:anywhere
to reduce intrinsic cell widths; the corrected chart/table probe passes in
Chromium compact/light, Firefox tablet/dark and WebKit desktop/light. This is the
only application change after f83e190. Fresh final-source focused checks and all
72 field cases are required; retain the other 342 cases explicitly at f83e190.
Final screenshots and preserved MCP, Operating Pack and Phase6 workflows remain
pending. No final-source 414-case claim is made.


8.6 final feature evidence: source579dec6aab59e17b21b3cf73cde9cc6b7adee54e,
tree0e60fb1fdf311eccb08774d7856f965a627de313, fingerprint
52032b95c94b8ab1b8f06b81455220464f18d338dd15589f8b6943b71b9577a1.
293 focused tests/29 files, typecheck/pack,72 final field browser cases, MCP64,
Operating Pack140 automated assertions and Phase6 42 PASS; source unchanged.
Six final screenshots inspected. The Operating Pack's three physical-device/AT
checks remain explicitly external NOT RUN, not automated evidence.

Retain342 unaffected browser cases atf83e190 from the validated414-case union
of225 completed pre-pause cases and189 resumed cases. The paused report remains
exit130; the resume is exit0. The table-only change afterf83e190 is covered by all
72 final field cases; no single-head414 result. Failed baselines, interruption
and an empty anchored command selection remain retained. Exact evidence:
`docs/roadmap/evidence/P8-field-evidence-579dec6.json`. Contractv2 copies remain
identical; no migration, secret, remote infrastructure or provider change.
Remaining Phase8 implementation and full canonical/native qualification stay
pending; physical devices, native zoom, human AT and independent acceptance are
not inferred from Playwright or agent screenshot review.


## 8.7: Community and Event relationships

Pack v7 adds Relationship owner (person) and Next conversation (date) to People
and Organizations. Attention uses those fields without enabling unassigned
triage. Named Membership filters support people with several memberships; the
global first-value grouping behavior is unchanged. Organizations group by
Partnership status, and both databases have dated-conversation views. Existing
team attention settings, enabled forms, mappings, and deleted reservations are
preserved by the additive upgrade. Upcoming Events use the workspace date.

The eventops block shares eventOpsPage/roleCoverage across the HTTP endpoint,
MCP dashboard_snapshot and indexed account-local device reads. It counts distinct
accessible People separately in each configured role, normalizes reverse
relations and displays capacity without enforcing it. Recent participant links
are explicitly current relationships, not submission receipts or attendance.
There is no receipt collector, inferred form attribution or attendance write.
Source and repair links open existing editors; form setup is linked only when
the configured participant database is accessible. New Event registration
starters remain disabled until an Event is selected. The configured form's
canonical reverse-to-primary relation planner is covered by regression tests.

Worker reads project bounded metadata only: 200 candidate Events, 1000 relation/
People candidates plus cap sentinels, and 100 board candidates. Caps, field
drift, missing dates and unavailable identities are explicit. Private sources
are gated, root revisions and current authority are fenced, and an explicit
source conflict permits one current-context retry. No answers, biographies,
attachment bytes or receipt payloads enter summaries. Device state is always
partial; it does not claim current server completeness. No new migration,
collection, provider, permission activation or website event-contract change.

Development evidence: 38 focused tests across five files PASS, covering both
permission modes, HTTP/MCP parity, bounded D1 calls, private People, deleted/
restored identities, access revocation, source races, pack preservation and
local-cache/retry behavior. The first browser fixture failed four cases before
application navigation because it assumed People had a stage column; the pack
uses no columns there. Preserve that failed report. Corrected compact Chromium
diagnostic passed all four journeys. Final frozen-source focused, 18-project
browser matrix, preserved workflows and visual review remain required. The UX
catalog now contains 66 cases across 18 projects (1188 combinations); adding
those cases does not mean the full catalog has been executed. Phase8 stays HOLD.


The first clean8.7 source789eab6 passed377 regression tests/36 files,
typecheck and pack validation. Screenshot review then found N34: nested rem
padding broke ordinary action words at200% text although overflow checks passed.
A real DOM Range assertion reproduces the two-line word failure. Keeping this
block's horizontal padding at its ordinary12px preserves text enlargement and
readable words; three representative engine/layout checks PASS and their images
were inspected. Earlier ineffective canvas and wrong-text-node probes remain
retained. This correction requires a new frozen source and affected checks.


The first144-case matrix atc0286a4 was stopped with25 PASS/5 FAIL/1 interrupted/
113 NOT RUN, exit130. Wide table controls exposed N35, a real selected-value
accessible-name mismatch, plus two test selectors that assumed compact cards.
Table/detail multi-select names now come from their rendered values plus hidden
field labels. An initial reconstructed label still failed two12-case diagnostics;
the automatic-content correction passes12/12 across Chromium tablet/light,
Firefox tablet/dark and WebKit desktop/light. Detail field selectors are scoped
to the record editor; membership assertions support both input and card titles.
Whole-page axe remains enforced. New frozen-source verification is required.


The frozen b3847d2 source again passed377 focused tests,typecheck/pack.
Adding whole-page axe on the open Person editor found N36: empty multi-select
prompts at2.58:1 on white. Its matrix was stopped21 PASS/1 FAIL/1 interrupted/
121 NOT RUN, exit130, retained. Light prompts now use neutral600, retaining
neutral400 in dark mode. Three-engine full membership/editor workflows3/3 PASS.
The editor-state accessibility assertion remains mandatory. This class-only
correction receives a new source freeze and final feature verification.


8.7 final feature evidence is bound to533fe09ef217a91628be296b5da1897c61691dd0
(tree6fcae611e72e36fb7e4e33d0db51d8dda6de4e6a; fingerprint
d68de24fe0d14bc1957f0c6d3f53d3bc9afd82464513cad64b56d93a88f503c4).
377 regression tests/36files,typecheck/pack,144 browser cases on18projects
(72 Community,54 Attention,18 pack upgrade), preserved MCP64,Operating Pack140
automated assertions and Phase6 42 PASS. All source-end checks stayed unchanged.
Six final Event desk screenshots were inspected. Physical iOS,physical Android
and human AT remain the pack report's three external NOT RUN checks. Native
qualification and full Phase8 certification remain incomplete; this selected
144-case run is not the full1188-case catalog. N33–N36 and all retained failed/
interrupted attempts are indexed in docs/roadmap/evidence/P8-community-533fe09.json.

For review, use the existing Template gallery upgrade preview to add packv7.
Existing attention/form settings and deleted reservations stay under normal
guarded mutation paths. People and Organizations with a Relationship owner
and dated Next conversation feed that owner's Attention queue. The Events desk
opens original Event/Person records and fixed-field repair links. Configure the
registration starter's Event before enabling/sharing it; links do not establish
attendance, consent or enforced capacity. No real installation was upgraded.
Next is8.8; overall Phase8 stays HOLD.
