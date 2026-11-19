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
