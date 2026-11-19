# Phase 13 preflight

Read-only preparation on 18 November 2026. Updated on 19 November after Phase12 acceptance.
The roadmap requires the preceding phase to pass before the next phase starts.
Phase12 passed all34 mandatory gates on19 November2026 at`fb3a0bd`.
On 18 November 2026, the owner explicitly chose to wait for that security fix.
The withdrawn advisory and passing certificate satisfy that gate. Phase13 may now start.

## 13.1 History diff

Reuse the existing session-authenticated, revision-fenced restore job. Add a
bounded, pure word diff and readable field selection. Large inputs need an
explicit bounded fallback, preserving complete before and after values.

Body history needs historical parent metadata. Joining history to a block's
current parent would misattribute moved blocks. An additive migration may be
needed to retain before/after parent and creation metadata in the existing
atomic history write. Old entries without that metadata must remain explicit.
Gate the root, each child and historical spaces, then recheck current access.
Do not enable structural ownership restores through the ordinary field allowlist.

## 13.2 Changes that did not win

The engine pushes before it pulls and removes acknowledged outbox entries.
Pending-only detection would therefore miss ordinary lost LWW edits. Retain
bounded local candidates until the server echo settles them, and inspect pending
candidates during rebase. Use account-local meta, with at most 200 conflicts
and 14-day retention. Clear retained copies on access eviction or quarantine.

Cover legacy and Protocol 3 pull paths. Pulls do not expose a remote actor;
display an unknown actor rather than invent one. Use mine must use guarded
`mutate()` and cannot discard a newer conflict through a stale action. Label
coverage as conflicts observed by this device.

## 13.3 Spaces as mention groups

Owner decision D13 selects existing spaces. Extend token parsing, markdown,
resolvers and editor pickers with `@[group:ID]`, preserving existing token and
caret behavior. No new mention-group tables are needed.

Resolve current active members, cap recipients at 20, exclude the actor and
intersect current target readability. The existing single-recipient helper
makes several D1 binding calls. Do not loop it 20 times. Use bounded reads and
batched writes while retaining canonical membership/revision fences, current
preferences and delivery receipts. Deduplicate overlapping direct and space
mentions without invalidating existing pending-event receipt identities.
Fence the source block/comment as well as the target before copying excerpts.

## Remaining scope

Optional share passwords and Google sign-in have not passed their request/usage
gates. External connector host acceptance requires separately approved public
tunnels and remains NOT RUN. Track A remains gated on owner production release
R3 and merged account-disable work.

Use Turnpack for grouped context and verified edits, narrow checks per feature,
the affected three-engine responsive matrix, then one full certificate on the
final committed Phase 13 source. Keep all interrupted or failed evidence.
