# Phase 13 implementation

## Record history

`History.tsx` presents a selected revision and readable word-level differences.
Native checkboxes choose fields for the existing restore job. A retained request
ID handles retry after an uncertain acknowledgement. Account, session, access
epoch and request generation fence responses and updates. The sheet uses the
existing focus, dismissal and responsive primitives.

The shared `textDiff` uses Unicode word segmentation. Detailed comparisons are
bounded to 250,000 cells. Larger changes retain complete removed and added
values, with an explicit simplified-display message.

Migration 0044 adds nullable before/after parent IDs and creation metadata,
plus parent/revision indexes to `record_history`. The atomic history statement
retains unchanged text needed when a block moves or is deleted. Previous
migration contents are preserved. Historical entries without parent context
remain unattributed to body history.

`GET /api/history/:id/body` and MCP `get_record_history` with `body:true`
read at most 51 candidates for a 50-entry page. Root, block and historical
parent access is checked. The final canonical authority batch fences current
revisions and historical spaces. The ordinary restore route remains the write
path and refuses protected structural fields.

The focused history checks and three-engine browser diagnostic are recorded
in the roadmap progress ledger. Phase 13 full browser verification and
certification remain pending, together with the conflict viewer and group
mentions.

## Conflicts observed by this device

Ordinary acknowledged edits retain their immutable field candidates in account-local
`meta` before queue deletion. Both legacy and Protocol 3 pulls compare candidates
and pending edits with the server echo, atomically with record/cursor updates.
Guarded upgrade edits and refused writes keep their existing recovery paths.
Seed timestamps are excluded. Each candidate/conflict pool retains at most 200
fields for 14 days. Pruning runs once per accepted pull page or push batch.
Access eviction and read-only/revoked access clear retained recovery payloads.
No new synced collection, remote table or permission grant is introduced.

Reliability and page/record headers open the review. Unknown remote actors remain
unknown. Review tokens and current field timestamps/value fence stale actions.
Use mine calls guarded `mutate()` inside the recovery transaction; write failure
preserves the review. Values exceeding the existing guard limit remain selectable
for manual recovery, with an explicit explanation. Dismiss only removes the exact
reviewed token. The dialog stays open after the final action so its confirmation
can be read. Account, session and access-epoch barriers hide stale responses.

## Existing Spaces as mention groups

The approved D13 model uses `@[group:ID]`, with no new group tables.
The editor's Space picker and chip resolver use the current access manifest.
Assistant chips and markdown preserve inaccessible tokens without disclosing
Space names. MCP loads only named IDs and intersects current canonical access
with the connector's currently approved scope. Copying a token grants no access.

Semantic derivation adds only newly introduced group tokens. New group events
follow the historical sequence, including synthetic extras, so existing direct
receipt identities survive queued-event replay. Group and direct mentions from
one source are deduplicated per recipient. A shared statement builder retains
existing notification grouping, delivery receipts and email/push outboxes.
Group channel delivery uses scheduled recovery, not per-recipient send bursts.

Fan-out caps eligible recipients at 20 and uses four binding calls: source graph,
batched state/member/content reads, grouped notification lookup and atomic writes.
Both target and source graph revisions, current membership, recipient preferences
and activation mode are fenced in the write transaction. Removed tokens and moved
or deleted sources do not broadcast obsolete text. The canonical Space role kernel
includes default member access and explicit denials. Disabled recipients are excluded.
The limit test uses 25 labelled synthetic fixture members; it grants no real seats.

## Completion gates

All three requested feature items are implemented. Optional share passwords and
Google sign-in remain request-gated. Additional external MCP host acceptance is
NOT RUN without an approved public tunnel. Track A remains gated on owner R3
production release and merged item7.3. No deployment or permission activation is
part of local Phase13 certification. Final browser and mandatory evidence must
name the exact committed source.


Space-token boundary coverage includes assistant apply-to-selection (preserve only
sourced tokens), generic visitor-input neutralization, search token stripping,
public page identity redaction and atomic Backspace deletion. Public Space labels
never resolve a name or membership through an anonymous capability.
