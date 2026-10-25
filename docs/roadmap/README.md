# TCG Workspace — next phases: execution prompt and implementation plan

Audience: the implementing model (Sol 6.1 via Codex). This is both the execution
prompt and the implementation plan for everything after the integrated release
candidate. Read it top to bottom before touching code. Prepared 2026-10-25 against
Workspace source `528b889e6351a2955ca2c893725a89da088336c6` (PR #14 head).

## 1. Mission

Turn the Workspace from a set of capable modules into an operating system the
seven-person TCG team acts from every day. Build on what exists. Nothing here
replaces an existing subsystem; every phase extends one.

You will, in order:

1. Finish acceptance of the integrated source and ship a small date-filter fix
   with it (Release track R).
2. Lay the shared foundations the new work depends on: relative dates, one
   workspace "today", workspace currency, account disable, template upgrades
   (Phase 7).
3. Build "operating desks": dashboards that lead to an action, starting with a
   shared attention queue (Phase 8).
4. Add everyday conveniences: CSV, export, resolved comments, bulk edit, search
   date filters, expiring share links (Phase 9).
5. Add out-of-app notifications (Phase 10) and larger file storage (Phase 11)
   once the owner has provisioned the external services.
6. Add general database power (rollups, formulas, charts, automation branches)
   only where Phases 8–9 proved the need (Phase 12), then polish (Phase 13).
7. Build the tooling the owner needs to activate permissions safely (Track A).

## 2. Boundaries (non-negotiable)

You MAY:
- Create branches from the accepted base (§5), commit, push them, and open
  **draft** PRs.
- Run everything locally: vitest, Miniflare/local D1, `wrangler dev` on loopback,
  Playwright, the UX lab, Android emulators, Apple Simulator.
- Write scripts and runbooks the owner will execute.

You MUST NOT:
- Merge any PR. Change, retarget or push to PRs #7, #9, #12, #13, #14 or website
  PR #23 or their branches.
- Run `wrangler deploy`, any `wrangler ... --remote` command (even
  `d1 migrations list --remote` writes), create Cloudflare resources (R2 buckets,
  KV, D1, queues, Email Routing), set secrets, or change DNS.
- Send real email or push notifications, process payments, mint tokens, or call
  paid AI providers. Use simulated providers and label results "simulated".
- Enable permissions outside disposable fixtures. Never describe a
  disabled-mode result as enabled-mode evidence.
- Open public tunnels. Loopback only.
- Relabel a failed or interrupted run as PASS. Keep failed evidence.
- Commit secrets, test passwords, applicant payloads or personal data.

Owner-only actions are listed per phase under "Owner actions". Prepare them;
never perform them.

## 3. Documents in this pack

| File | Contents |
|---|---|
| [KICKOFF.md](KICKOFF.md) | Short first message to start the implementing session |
| [00-baseline.md](00-baseline.md) | Verified current state, open findings register (IDs), owner decisions |
| [R-release.md](R-release.md) | Release track: finish certification, R1 date fix, owner release runbook |
| [07-foundations.md](07-foundations.md) | Phase 7: dates, workspace locale, account disable, template upgrades |
| [08-operating-desks.md](08-operating-desks.md) | Phase 8: attention queue + seven desks + reliability/automation/AI review views |
| [09-everyday.md](09-everyday.md) | Phase 9: CSV, export, resolved comments, bulk edit, search dates, share expiry |
| [10-notifications.md](10-notifications.md) | Phase 10: email channel, digests, web push |
| [11-storage.md](11-storage.md) | Phase 11: R2 file storage |
| [12-database-power.md](12-database-power.md) | Phase 12: rollups, formulas, chart view, automation branches, canvas export |
| [13-polish.md](13-polish.md) | Phase 13: history diff, conflict viewer, group mentions, share passwords, connector tests |
| [A-access-activation.md](A-access-activation.md) | Track A: permission-activation tooling (owner executes) |
| [correlation-matrix.md](correlation-matrix.md) | Every feature × files × tables × MCP/AI × tests × migrations × dependencies |
| [deferred.md](deferred.md) | Things deliberately NOT to build, with reasons |

Also read before coding: `AGENTS.md` (invariants), `docs/architecture/README.md`,
`docs/architecture/cross-platform-responsive-web.md`,
`docs/architecture/phase-5-implementation.md` (current runtime contract),
`docs/architecture/phase-6-implementation.md`, `docs/architecture/unified-ai-mcp.md`,
`docs/integrations/the-common-ground.md`, `docs/testing/UX-LAB.md`.

## 4. Order and dependencies

```
R0 finish acceptance ─► R1 date-window fix ─► (owner) R3 release to production
                              │
                              ▼
Phase 7 foundations (7.1 dates → 7.2 locale → 7.3 disable → 7.4 template upgrade)
      │                    │
      ▼                    ▼
Phase 8 desks         Phase 9 everyday (independent features; 9.6 needs 7.1)
(8.1 attention queue first; desks after)
      │
      ├─► Phase 10 notifications (needs 8.1 + owner email/VAPID setup)
      ├─► Phase 12 database power (only items proven by 8.5/8.6)
      ▼
Phase 13 polish

Phase 11 storage: independent; needs owner R2 bucket.
Track A access activation: after R3 is live and 7.3 is merged; owner executes.
```

Do not start a phase until the previous phase it depends on is committed, its
tests pass, and its PR is open. Within a phase, implement items in the listed
order.

## 5. Branching, stacking and migrations

- **Plan base.** This pack lives on branch `plan/next-phases`: one docs-only
  commit on top of `528b889`, with no code changes. Every Sol branch starts from
  it, so the plan and `PROGRESS.md` travel with the code. The application code
  at that commit is byte-identical to `528b889`.
- **Accepted base.** R0 certifies either `528b889` or R1's head (owner decision
  D1, recommended R1's head). Record the full SHA in the ledger.
- **One stacked branch per phase**, each based on the previous phase branch, so
  migration numbers never collide:
  `plan/next-phases` → `sol/r1-date-window` → `sol/p7-foundations` → `sol/p8-desks` →
  `sol/p9-everyday` → `sol/p10-notifications` → `sol/p11-storage` →
  `sol/p12-database-power` → `sol/p13-polish`; `sol/track-a-activation` stacks
  on `sol/p7-foundations`.
  Open each as a draft PR whose base is the previous branch.
- **Migrations.** Latest is `0034_website_source_authority.sql`. Take the next
  unused number at implementation time (expected sequence in
  correlation-matrix.md §3). Migrations are additive only: new tables, new
  nullable columns, new indexes, triggers. No destructive change to an existing
  table, ever. Each migration must also update:
  - `scripts/certification/migrations.json` (name + SHA-256 of exact bytes);
  - the hard-coded count in `scripts/release-preflight.mjs` (currently
    `manifest.length===34`) and its test `scripts/certification/release-preflight.test.mjs`;
  - `scripts/release-rehearsal.mjs` (manifest length);
  - `tests/phase4-migrations-d1.test.ts` if it enumerates files.
- **Feature flags.** Every new environment variable defaults OFF in
  `wrangler.jsonc` and must be added to the optional-disabled list in
  `scripts/release-preflight.mjs` (see the `AI_PROVIDER` check at line 43 and
  `operatorConfiguration` at line 72), with a preflight test.
- **Dexie.** The client store is at `version(9)` (`src/core/db.ts:123`). A new
  local table or index means `version(10)` with an upgrade, plus coverage in
  `tests/phase5-cache-upgrade*.test.ts`.

## 6. Global invariants (from AGENTS.md, restated because they bite)

1. Client writes go through `mutate()`; server writes through `applyChanges()`
   (`worker/sync.ts`). Never write the `records` table directly.
2. User-visible reads go through the read gate (`withReadGate`,
   `createReadGate(db,userId).decide(ids)`). Unauthorized ≡ missing. Stored
   copies of record content (notifications, approvals, emails, caches) are
   re-checked at read/send time and rendered as "Restricted item" otherwise.
3. About 45 D1 calls per request/cron phase (`withD1Budget`). Use `db.batch`,
   `json_each(?)`, keyset cursors. Never one query per record. The approvals
   list currently calls `loadTargetMeta` per row (`worker/approvals.ts:380`); do
   not copy that pattern.
4. Pure logic shared by client and worker lives in `shared/` with unit tests.
   Totals shown in the app and returned by MCP must come from the same function.
5. Soft delete only. Any rejection is item-wise (`rejectedItems`).
6. Server-only tables are never synced collections. New server tables go in
   the AGENTS.md list.
7. Every new MCP tool:
   - registered via `reg()` (writes) or with `readOnlyHint:true` (reads);
   - classified in `shared/aiCapabilities.ts` (the registry test
     `tests/assistant-registry.test.ts` requires the exact same set and matching
     read flags);
   - added to the significance rule in `worker/mcp.ts:674` if it can delete,
     change schema, or touch >25 records;
   - described in the server instructions text in `worker/mcp.ts` (~line 560).
8. Every new embedded-assistant action goes in `shared/aiActions.ts`; the
   prompts are generated from it.
9. The scheduler has exactly `SCHEDULED_PHASE_COUNT=9` rotating phases on one
   15-minute cron (`worker/reminders.ts:21`, list at ~line 318). Adding a phase
   means updating the constant, the inventory, and the rotation regression test.
   Do not add a second cron trigger.
10. AI providers stay OFF by default; AI never self-approves; outputs that change
    records are previews or suggestions.
11. Cross-platform is part of done: compact/tablet/desktop layouts,
    keyboard + touch alternatives for every drag or hover, WCAG 2.2 AA, light and
    dark, offline states that distinguish "saved on this device" from "synced".
12. D1 test files must match the certification regex
    `(phase[456]|audit|assistant)-.*-d1\.test\.ts` (`scripts/certify-phase4.mjs:118`)
    or they are silently excluded from the d1 gate and its cost evidence. Either
    name new files `phase7-…-d1.test.ts` etc. **and extend the regex to
    `phase([4-9]|1[0-3])`**, or reuse an existing prefix. Extending the regex is
    item 7.0 of Phase 7.

## 7. Definition of done (every item)

- Code, migration (if any), shared pure functions with unit tests.
- D1 tests for any server path, including a binding-call cost assertion with
  `withD1Budget(45)`, run with permissions DISABLED and ENABLED where access
  matters.
- Browser coverage: Chromium, Firefox and WebKit at compact (390), tablet (768)
  and desktop widths, keyboard-only path, axe with zero violations. Add cells to
  the UX lab (`npm run qa:ux`) for every new screen; re-record visual references
  only for surfaces you changed and say why in the PR.
- MCP/AI wiring per invariant 7–8 when the feature has an AI surface.
- Docs: update `AGENTS.md` (module map and invariants), the relevant
  `docs/architecture/` file, and this pack's ledger.
- `npm run typecheck`, `npm test`, `npm run build` pass. At phase end, a full
  `npm run certify:ai` on the phase head with the Mac awake (see R0 lessons).
- PR description: what changed, evidence with exact commands and exit codes,
  what was NOT run (physical devices, screen readers, real providers), owner
  actions required.

## 8. Progress ledger

Create `docs/roadmap/PROGRESS.md` on your first branch and update it at every
commit: item ID, status (not started / in progress / done / blocked), commit
SHA, evidence path, and notes. Interrupted work resumes from the ledger without
repeating verified steps. Keep raw evidence in ignored `.artifacts/`.

## 9. Reporting back

At each phase end report: branch, head SHA, tree, PR URL, items done, test
counts, certification decision, NOT RUN gates, owner actions now unblocked, and
any finding you discovered (add it to 00-baseline.md's register with a new ID).
