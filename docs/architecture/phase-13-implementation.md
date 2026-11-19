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
