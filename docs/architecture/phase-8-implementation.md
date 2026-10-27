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

Focused checks: 60/60 across reliability, real client sync ordering, media,
transaction rollback and pack client regression tests; typecheck passes. The
three compact Chromium workflows pass, including offline edit -> server receipt,
forced 507 -> retained bytes -> explicit retry -> identical server bytes, and
held-review/rejected-export separation. Earlier failed probes were fixture
selector errors and remain retained. Three-engine matrix and the new opt-in
`--reliability` Android upload-recovery journey still need execution. Emulator
results must remain distinct from physical-device or human acceptance.
