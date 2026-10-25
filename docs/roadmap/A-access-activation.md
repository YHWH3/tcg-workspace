# Track A — Permission activation readiness (Sol builds tooling; owner activates)

Branch `sol/track-a-activation` stacked on `sol/p7-foundations`. Do not start
until production runs the release (R3) and 7.3 (account disable) is merged.

Permissions (spaces, roles, guests, filtered sync) are implemented and certified
but OFF (`access_state.enabled=0`). The authoritative runbook is
`docs/architecture/phase-5-implementation.md` ("Activation and release runbook
(not executed)", six steps). This track builds what that runbook needs. **Sol
never flips the flag on a non-disposable database.**

## A.1 Inventory script

`scripts/access-inventory.mjs <dump.sql>` reads a LOCAL copy of the production
D1 (exported by the owner) and outputs JSON and Markdown covering:
- accounts with workspace role, disabled flag and last session;
- spaces and memberships (Core default);
- records per space, and records without a space or with an unknown space;
- root ownership and orphan graphs (pages whose parent is missing, relation
  links whose endpoint is missing);
- shares with their pinned space, and shares whose page moved;
- legacy OAuth grants and connector scopes;
- the guest-directory restriction flag;
- quota headroom;
- migration hashes vs `scripts/certification/migrations.json`.

It refuses any non-file input.

## A.2 Populated rehearsal fixture

`scripts/access-rehearsal.mjs` loads the dump into a disposable Miniflare D1 and
runs these in order, writing a report:
1. activation (manifest, backfill, atomic group activation as specified);
2. two simulated clients (old Protocol 3 cache, offline pending writes);
3. cross-tab version fencing and restart;
4. offline quarantine;
5. revoke and regrant;
6. relation peers;
7. file and object-URL eviction;
8. stale network responses.

It reuses the existing phase5 sync/workflow harnesses (`scripts/verify-phase5-*`;
verify names) pointed at the rehearsal database, and records PASS/FAIL per step
with exact commands.

## A.3 Restricted-content verification

A post-activation check script (run by the owner against staging first):
- a sample of restricted records per space for a member who must not see them;
- assert absence through every read surface: sync pull, search, MCP `search`,
  `fetch`, `query_records`, `dashboard_snapshot`, `attention_queue`,
  notifications, approvals, public shares, history, digests, emails (simulated);
- report counts only, never content.

## A.4 Owner runbook additions

Extend `docs/roadmap/RELEASE-RUNBOOK.md` with an "Activate permissions" section:
- prerequisites (D11 approved, backups and restore tested, A.1 clean, A.2 all
  PASS on today's dump);
- exact owner commands;
- a monitoring window;
- the rollback statement copied from the Phase 5 runbook: turning the flag off
  does not erase downloaded data or undo writes.

## Done when

The inventory runs on a dump, the rehearsal passes on a dump, the verification
script exists with tests on a fixture, and the runbook section is written. The
owner decides activation separately.
