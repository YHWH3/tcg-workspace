# TCG CRM: product design and architecture specification

Version 2.2, 24 November 2026. Version 1 was written in a separate session from a read-only inspection of the code at `38c388a`. Version 2 was checked against the actual source in this checkout, corrected where it was wrong, and updated with the owner decisions of 24 November 2026 (A-19 to A-26 in `01-DECISIONS.md`). Version 2.2 closes ChatGPT's independent review of S0 contracts (CR-01 through CR-06) with [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md), updates A-26 to the revised single-engineering-agent operating model (Neon owning both backend and frontend under ChatGPT review and Paul's approvals), restructures [`S0-PLAN.md`](S0-PLAN.md) into a backend-first sequence, and adds [`PROGRESS.md`](PROGRESS.md).

This is still design and architecture. No application code (`src/`, `shared/`, `worker/`, `migrations/`) was changed, nothing was merged into `38c388a`, no remote migration was run, and no provider or production permission flag was activated. Only files under `docs/crm/` changed. The baseline test run is reported below with actual counts.

## Baseline reference

| Item | Value | How checked |
|---|---|---|
| Workspace engineering baseline | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) | `git rev-parse codex/workspace-database-platform` |
| Branch | `crm/foundation` (tracks `origin/crm/foundation`; prior doc commit `d1742a09cb1972644ba869134208dc70a76524d7`) | `git branch --show-current`, `git log -n 2` |
| Remote | `YHWH3/tcg-workspace` | `git remote -v` |
| Package | `workspace` `1.0.0-rc.1` | `package.json` |
| Migrations | 44 files, `0001_init.sql` to `0044_history_body_context.sql`, all registered in `scripts/certification/migrations.json` | `ls migrations` |
| Test files | 218 `*.test.ts` in `tests/` | `ls tests/*.test.ts` |
| Runtime used | Node `v26.7.0`, npm `11.19.0` | `node -v`, `npm -v` |

## Reading order

| File | What it answers |
|---|---|
| `00-README.md` | Baseline, evidence, verification log, invariant check, baseline test results, questions, remainder |
| `01-DECISIONS.md` | The single decision ledger: approved, source-supported, proposed, open |
| `02-EVIDENCE-AUDIT.md` | TCG relationship model from the sources, and the Workspace capability and gap audit with code citations |
| `03-MONDAY-STUDY.md` | What Monday CRM actually does, what TCG should adopt, adapt or reject |
| `04-PRODUCT-SPEC.md` | Scope, non-goals, the 14 programmes, workflows and acceptance criteria |
| `05-ARCHITECTURE.md` | Architecture decisions (ADR-01 to ADR-14) with rejected alternatives |
| `06-DATA-MODEL.md` | Entities, ERD, source-of-truth matrix, migration, backfill and rollback |
| `07-CONTRACTS.md` | Command catalogue (including capability grant and revoke), permission matrix, error codes, adapters, MCP surface |
| `08-UX-SPEC.md` | CRM shell, navigation, screens (including Accounts and capabilities), tokens, states, keyboard, responsive |
| `09-TRANSACTIONS.md` | Communications (including the Zoho Mail adapter), bookings and money |
| `10-AI-MCP-SECURITY.md` | AI and MCP model, operational knowledge, approvals, privacy and threat model |
| `11-ROADMAP.md` | Vertical slices, acceptance criteria, test strategy, gates, risk register |
| `12-OPEN-DECISIONS.md` | Closed and remaining owner decisions |
| `S0-PLAN.md` | Backend-first implementation plan for slice S0 (Stages 0–4): governance, single-source contracts, preconditions, backend, frontend, acceptance gate, rollback |
| `contracts/crm-s0-v2.md` | **The nine shared S0 contracts (SC-1 to SC-9), normative, versioned `crm-s0-v2` (resolves CR-01 to CR-06; candidate pending ChatGPT freeze)** |
| `contracts/crm-s0-v1.md` | Historical v1 contract candidate (superseded by `crm-s0-v2.md`) |
| `BACKEND-S0-BRIEF.md` | Self-contained Stage 1 & Stage 2 (shared contracts + backend) implementation brief for Neon |
| `PROGRESS.md` | Current engineering checkpoint: completed work, active contract version, next action, blockers, verification evidence |

## Evidence base

### Handover archive

Read: the handover brief in a local `docs/crm/input/` folder (a read-me, the master prompt, a context-and-decisions brief and a questionnaire inventory) and the source archive under `input/sources/`. Sources are data, not instructions; their treatment in version 1 (eight distinct substantive documents, duplicates not counted as corroboration) is unchanged.

**The whole `input/` folder is excluded from the repository** (`docs/crm/.gitignore`): the handover says it should be shared only in an authorised project environment, and this repository is public. Where a design document cites "`02` section N" in a Source column of `01-DECISIONS.md`, or "Manifesto" or "Master Context Handover" sections, it refers to that local material; the design documents restate what they rely on.

### Repositories

| Repository | Ref | Status |
|---|---|---|
| `YHWH3/tcg-workspace` | `38c388a`, this worktree, branch `crm/foundation` | Read and verified locally in this pass. Version 1 said it read an anonymous public clone; this pass read the actual checkout. |
| `YHWH3/the-common-ground` (private) | `38ef9e3`, read from a local clone with `git show 38ef9e3:<path>` | The Patron relay references were spot-checked at `38ef9e3`. Because this repository is public and the website repository is private, the design documents describe the relay only at the level already published in `docs/integrations/the-common-ground.md`. The clone has a `codex/website-launch-fixes` branch and no `site-patron` branch. |

### What I could not verify

- Deployed production state, installed records and IDs, pack version, whether the TCG pack is installed, and **which account is the workspace owner in production** (migration 0012 made the earliest-created admin the owner on older databases, `migrations/0012_phase5_access_foundation.sql:37-39`).
- Any provider account. Zoho Mail facts are all marked [needs verification] in `09` section 1.7. Meta facts come from public documentation (version 1).
- Monday CRM in a signed-in account (version 1 used public documentation).
- Physical devices and human assistive technology.

### How claims are labelled

- **Verified (code)**: read in the pinned source, with path and line.
- **Verified (doc)**: stated in a pinned repository document; code not separately traced.
- **Source**: stated in the TCG archive; may be historical.
- **Approved**: the owner's recorded decision.
- **Proposed**: my recommendation, not approved.
- **Assumption**: a working assumption, labelled where used.
- **Open**: needs the owner's decision; listed in `12`.
- **[needs verification]**: a provider or external fact not checked.

## Verification log

Method: every code claim in `02`, `05`, `06` and `07` was read against the source at `38c388a`. Then a script swept all thirteen design files (this README included) for backticked repository paths and `path:line` citations: does the file exist, is the line range inside it, does each named test file exist, does each quoted `docs/roadmap/deferred.md` phrase appear. Result after the fixes below: **634 checks, 0 problems** (re-run at publication; paths written relative to a document's own folder are resolved from that folder). The sweep checks existence and range, not meaning; meaning was checked by reading, and every line number added in this pass was re-read after writing.

Corrections. Where a design decision rested on the wrong fact, the design was revised.

| # | Document | Was | Actually (evidence) | Design change |
|---|---|---|---|---|
| V-01 | `02` B2, `05` ADR-04, `07` | `authorizeMutations` rejects client fields starting with `_`, so projection keys are protected | The rule exists (`worker/mutationAccess.ts:66-67`), but `applyChanges` only calls `authorizeMutations` when `access_state.enabled = 1` or the request comes from a connector (`worker/sync.ts:352-355`). The only test of the rule enables permissions first (`tests/phase5-audit-interplay-d1.test.ts:68,78`). With permissions off, which is how the pilot runs (A-19), a client push could write `_crm_` fields today | **Revised.** An unconditional, item-wise `_crm_` pre-check in `applyChanges` for both modes, plus a projection grant passed to `authorizeMutations` for registered commands (ADR-04; `S0-PLAN.md` section 6.3) |
| V-02 | `07` section 1, ADR-04 | Commands commit operational rows and projections "in one batch" through `applyChanges` | `applyChanges` issues no batch at all when no record changes (`worker/sync.ts:553-556`); server-only rows ride the batch today only through `execution.checkpoint`, per record (precedent `worker/aiSuggestions.ts:70`) | **Revised.** Two commit modes and a `commit` option that always commits with its fences (`07` section 1; `S0-PLAN.md` sections 6.3 and 6.5) |
| V-03 | `05` ADR-02 | Put `crm/*` "inside the existing `RequireAuth` wrapper" so it covers `AccountSwitchGate` and the sync start | The existing wrapper's element is `<RequireAuth><Shell/></RequireAuth>` (`src/App.tsx:53-70`); a child would render inside Workspace chrome. `AccountSwitchGate` and `LegacyRecoveryGate` sit outside the router (`:90-91`), and the sync engine starts once in `App()` (`:73-85`) | **Revised.** A separate top-level `crm/*` route wrapped in its own `RequireAuth`; React Router ranks it above the catch-all `*` (`:68`); SPA fallback confirmed (`wrangler.jsonc:11`, `src/sw.ts:90`) |
| V-04 | `01` C-04, `02` B2 | Seven-account cap enforced "in admin (`worker/admin.ts:130`)" | `admin.ts:130` is the re-enable path. Signup enforces it at `worker/auth.ts:284` and atomically in the insert (`:308-316`) | Citation fixed |
| V-05 | `02` B3, `06` Places | The Places Relationship select contains Active, Partner, Historical | Those are stage columns; the select options are Owned, Leased, Partner, Community, Other (`templates/tcg-pack.json`, `places`) | Pack-upgrade plan reduced to adding Associated and Applied |
| V-06 | `02` B2, `05` ADR-11 | 20 MB is a D1 file limit; channel media should go to R2 | 20 MB is per file in both storage modes (`worker/fileStore.ts:26`, `src/core/chunks.ts:3`). R2 is implemented but **not enabled** at the pinned config (`wrangler.jsonc:22-24`: `r2_buckets` commented out, `FILE_STORAGE` `d1`) | ADR-11 and `09` section 1.7 say enabling R2 is an owner step before channel media |
| V-07 | `02` B2, `06` | Email field "found by name 'Email'"; ID `person_<sha256(...)>` | Any text or url field named "Email" or "E-mail", case-insensitive (`worker/websiteIngest.ts:426-429`); the ID is truncated to 48 hex characters (`:445-447`); People rows are `tasks`-collection records | Wording made exact |
| V-08 | `06` Organisations, Events | "Location" implied to exist on Organisations; Events datetime | Organisations has no Location field; Events has date-only Start date and End date (`templates/tcg-pack.json`) | Both marked as new fields; existing date fields kept |
| V-09 | `07` section 3 | `crm_capability_grants` keyed by (user, capability, programme) with role-based defaults (Admin "yes" for open CRM, merge, connect channels) | No role implies anything (A-21); the owner is implicit | Permission matrix rewritten; capability grant and revoke commands, owner-implicit rule and an audit table added |
| V-10 | `07` section 8 | CRM tools are "added to `shared/aiCapabilities.ts`" | `CapabilityModule` is a closed union (`shared/aiCapabilities.ts:19-22`); a `'crm'` member is needed and `tests/assistant-registry.test.ts` enforces registry parity | Stated; no MCP tool in S0 |
| V-11 | `07` section 1 | `requestId` 8-64 characters | Repository MCP `requestId` is 1-64 (`AGENTS.md`) | Kept 8-64 for CRM commands and labelled as a CRM choice |
| V-12 | `07` section 7 | Adapter providers `email_gmail`, `email_routing` | Mailbox is Zoho Mail (A-22) | `email_zoho`, plus a `poll` method for pull providers and an `unknown` send outcome |
| V-13 | `02` B2 automations | Actions at `shared/automations.ts:43-50` | `:44-50` | Fixed |
| V-14 | `02` B2 mutation access | `worker/mutationAccess.ts:65-67` | Condition at `:66-67` inside the loop starting `:65` | Fixed |
| V-15 | `01` section 2, C-03 | Website paths without the `website:` prefix | They are in the other repository | Prefixed |
| V-16 | `06` section 7 | Migration 0045 creates every CRM table empty | Freezing schemas before their slices adds no safety | S0 creates three tables; later tables arrive with their slices (`S0-PLAN.md` section 6.2) |
| V-17 | new | — | Any admin can demote, disable or remove the owner while another owner or admin remains (`worker/admin.ts:103-105,108-124,165-179,206-215`); there is no route to rename another account; people rename themselves via `PATCH /api/me` (`worker/auth.ts:454-475`) | C-06 / O-19; rename lands in S1 |
| V-18 | new | — | Migration 0012 assigned `owner` to the earliest-created admin (`migrations/0012_phase5_access_foundation.sql:37-39`) | S0 precondition: confirm exactly one owner and that it is Paul's account |
| V-19 | new | — | `scripts/access/selftest.mjs:33` hard-codes `0044_history_body_context.sql` as the last migration; `scripts/certify-phase4.mjs:181` fails on an unregistered migration; the D1 test selector (`scripts/certification/test-files.mjs:3`) does not match `crm-*` names | All three listed as S0 changes |

Confirmed as written in version 1 (sample of the load-bearing claims): `MAX_USERS = 7` (`worker/auth.ts:76`); 13 synced collections including `automations` and `forms` (`shared/collections.ts:5`); `mutate()` at `src/core/sync/engine.ts:172`; `applyChanges` at `worker/sync.ts:290` with `ApplyOptions` at `:158-194`; field types and number formats (`shared/fields.ts:4,16`); nine view types (`shared/views.ts:11`); the 5,000-record saved-view bound (`docs/roadmap/14-configurable-databases.md:79-80`); table widths are component-local (`src/core/views/TableView.tsx:32`); capacity is informational (`shared/eventOps.ts:9-10`); event-ops bounds of 200 events and 1,000 links (`worker/eventOps.ts:21-29`); "Focused operating summaries, not a ledger" (`shared/finance.ts:1`); email provider modes (`worker/email.ts:14-19`); automation triggers (`shared/automations.ts:19-24`); `gateTransition` (`shared/approvals.ts:72-86`); `withD1Budget` default 45 (`worker/d1budget.ts:18`); `COLLECTION_READ_LIMIT = 5000` (`worker/records.ts:79`); workspace defaults `UTC` and `INR` (`shared/workspaceSettings.ts:5`); the 15-minute cron (`wrangler.jsonc:49`); access disabled by default (`worker/readAccess.ts:63-66`, `docs/roadmap/A-access-activation.md:8-9`); pack version 11 with 17 databases, 38 pages, 6 forms, 5 automations; MCP registry with 90 tools (30 read, 51 write, 3 proposal, 6 human-only); integration contract retry policy and 24-hour Resend idempotency window (`docs/integrations/the-common-ground.md:172-175`); every cited test file exists.

## Check against `AGENTS.md` invariants

| Invariant | Where the design satisfies it | Fix made in this pass |
|---|---|---|
| Writes go through `mutate()` / `applyChanges()` | Relationship records through those paths; commands change records only through `applyChanges` and write only CRM server-only tables directly (`07` section 1, guarantee 7) | Guarantee 7 added |
| Server-only tables never in `COLLECTIONS` | All CRM operational tables server-only; S0 adds none to `shared/collections.ts`; an isolation test asserts it (`S0-PLAN.md` sections 5.3 and 6.6) | — |
| A policy refusal is item-wise | `_crm_` rejection is an item-wise pre-check in `applyChanges`, not a SQL abort | V-01 |
| One timestamp ordering | The pre-check reads only patch keys and runs after timestamp healing and restamping; it does not read `field_ts` | Placed after `:350` (`S0-PLAN.md` section 6.3) |
| Reads go through the read gate; unauthorized ≡ missing | CRM reads use `withReadGate`; CRM capability filters add to it; `not_found` covers both (`07` sections 2 and 4) | — |
| D1 budget (~45 calls) | Every command wrapped in `withD1Budget(env, 45)`; grant and revoke use three binding calls; tests assert the budget | — |
| No whole-collection reads | Capability and audit reads are keyed or keyset-paged | — |
| No module-level mutable state in `worker/` | Command registry built per request by `createCommandRegistry`; Zoho access tokens held per run | Stated in ADR service table and `07` section 7 |
| Credentials derive grants | Capability checks require an active account and a live session at check time; disabling an account revokes its CRM grants with audit rows and re-enabling restores none (A-25); removal cascades | Disable revocation added (`S0-PLAN.md` section 6.3) |
| Significant MCP writes need frozen preview and browser approval; MCP cannot approve itself; AI never holds authority | CRM side effects are human-only or proposal-only; capability grant and revoke are never MCP tools; AI holds no capability | `07` section 8 row added |
| Providers off by default; simulated provider only under `local-test` | Zoho adapter off by default; simulated adapter for tests and demo; exact egress hosts, `redirect: 'error'`, no fallback | `07` section 7, `09` section 1.7 |
| Website contract: change both copies together | S0 does not touch the contract; C-05 doc fix deferred to the next website change | — |
| Cross-platform responsive web, WCAG 2.2 AA, three engines and three layouts, real-device gates reported | S0 browser checks in 18 projects plus 320 px reflow, 200% text, target sizes, focus; real devices NOT RUN and reported (`S0-PLAN.md` section 9.3) | Reflow, text and target checks added after reading `docs/architecture/cross-platform-responsive-web.md` |
| Permissions stay off outside disposable fixtures | The CRM does not depend on activation (A-19); tests cover both modes in fixtures only | — |
| Env types after editing `wrangler.jsonc` | S0 changes `Env` in `worker/auth.ts`; `cf-typegen` only if `wrangler.jsonc` changes | Stated in `S0-PLAN.md` section 6.4 |
| Workspace preservation | Switcher behind `CRM_ENABLED` and `crm.access`; Workspace pixel-identical with CRM off; full suite and Studio check compared with the baseline | P-24 |

## Baseline test results (before any CRM change)

Run on 24 November 2026 in this worktree at `38c388a`, before any change outside `docs/crm/`. Node `v26.7.0`, npm `11.19.0`, macOS. Commands were chained in one background shell, in this order.

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | 547 packages added, 0 vulnerabilities reported. npm warned that install scripts for `core-js-pure` and `fsevents` are not covered by `allowScripts`. `package-lock.json` unchanged |
| `npm test` (`vitest run`) | 1 | **Test files: 3 failed, 215 passed (218). Tests: 3 failed, 2,227 passed (2,230).** Duration 1,535 s |
| `npm run typecheck` (`tsc --noEmit`) | 0 | No errors |
| `npm run build` (`vite build`) | 0 | Built; two `INEFFECTIVE_DYNAMIC_IMPORT` warnings (`shared/mooditems.ts`, `src/core/sync/engine.ts`); service worker precache 39 entries |
| `npm run demo:studio -- --check` | 0 | "Seeded 36 records and 19 views. Studio demo checks passed." Evidence in `.artifacts/studio-demo/run-6TUXvz` (git-ignored) |

**Pre-existing failures** (not fixed here; Workspace code was not touched):

| Test | Error in the full run | Re-run alone |
|---|---|---|
| `tests/phase4-events-d1.test.ts` > Phase 4 real D1 deadline indexing and reminder recovery > Cron recovers durable events after interruption and a failed sweep, then dedupes subsequent sweeps | `beforeEach` hook timed out in 30,000 ms creating Miniflare (`:93`) | `npx vitest run tests/phase4-events-d1.test.ts`: exit 0, 34 of 34 passed |
| `tests/phase8-commitments-d1.test.ts` > keeps private action metadata out while retaining available decisions | `read ECONNRESET` (`:54`) | `npx vitest run tests/phase8-commitments-d1.test.ts`: exit 0, 13 of 13 passed |
| `tests/phase8-form-operations-d1.test.ts` > fences disablement and session revocation during a read | Test timed out in 30,000 ms (`:92`) | `npx vitest run tests/phase8-form-operations-d1.test.ts`: exit 0, 15 of 15 passed |

Reading: all three fail only under the full parallel suite, through local Miniflare timeouts or a connection reset, and pass in isolation, so they are **flaky under load** on this machine, not deterministic defects. That is from one full run and one isolated re-run each; it is not proof of stability. The S0 gate treats these three by name and failure signature (A-24, `S0-PLAN.md` section 9.4); they are tracked as SI-01 in `12`.

Not run in this pass: `npm run qa:ux` (screenshot baselines; `S0-PLAN.md` section 9.1), `npm run smoke`, certification orchestrators, physical devices.

After the run: `git status --porcelain` shows only `?? docs/crm/`; `git diff --stat` is empty. `dist/`, `.wrangler/` and `.artifacts/` are generated output and git-ignored (`.gitignore:2,3,10`).

## Synchronisation for publication (24 November 2026)

Before the first commit of this folder:

- **Contracts versioned.** The nine shared S0 contracts are in `contracts/crm-s0-v1.md` (candidate). `S0-PLAN.md` section 3 is now an index pointing to it, and `07-CONTRACTS.md` names it as the normative S0 form.
- **Discrepancies found and resolved while writing the contracts:**
  - S0 has no programme registry, so programme-scoped grants could not be validated. The S0 contract accepts scope `*` only (SC-2 rule 7), and the Settings wireframe (`08` section 13.1) now shows scope "All" only. Programme scopes arrive with S2 as a contract change.
  - Two refusal reasons were missing: `account_disabled` (granting to a disabled account) and `not_admin` (granting `crm.capabilities.manage` to a member). Both are added to SC-5 and `07`.
  - `CRM_ENABLED` parsing now matches the existing `WEBSITE_INGEST_ENABLED` rule (`1` or `true`, `worker/websiteIngest.ts:139-141`) instead of `true` only.
  - The 401 body is the existing Workspace `{ error: 'unauthenticated' }` from `requireAuth` (`worker/auth.ts:217-222`), not a command envelope.
  - The Settings wireframe was missing two of the thirteen capabilities (Instagram and Facebook sending); added.
  - The disable-revocation audit `request_id` now includes a per-request UUID, so a second disable of the same account cannot collide with `UNIQUE(actor_id, request_id)`.
- **Publication review.** This repository is public. The commit excludes the handover folder and source archive, and the design documents were edited to remove a named private individual, the name of an independent space whose association is unverified, a restated regulatory-status claim, private-repository line references, and a social-media handle in a wireframe that could have been real. Remaining names are the owner's first name (recorded as decision evidence at the owner's instruction), the organisation's public website address and public contact address, and clearly fictional examples.
- **Backend handoff.** `BACKEND-S0-BRIEF.md` lets the backend workstream proceed from the repository alone.

## S0 questions: answered 24 November 2026

All three defaults were accepted with safeguards (A-23 to A-25 in `01-DECISIONS.md`):

1. **Owner protection (A-23).** Ordinary admins cannot demote, disable or remove the owner; last-owner protection is kept; enforced on the server in all three account routes, with a race backstop in the batch. UI hiding is not the control (`S0-PLAN.md` section 6.3).
2. **Baseline comparison (A-24).** Only the three SI-01 failures are tolerated, with unchanged failure signatures and passing isolated reruns; any new or changed failure blocks. The tests stay in place as an open stability issue and must be stabilised before production release (`S0-PLAN.md` section 9.4, `12` SI-01).
3. **Grants on disable (A-25).** Disabling revokes CRM capabilities with one audit row per grant in the disable batch; re-enabling restores none (`S0-PLAN.md` section 6.3).

**Division of responsibilities (revised A-26).** Opus 5.5 completed product discovery, independent architecture, repository audit, baseline testing and initial S0 planning. Under revised A-26, **Neon** (principal engineering agent in T3 Code) owns technical architecture refinement, shared contracts (`shared/crm/*`), migrations, backend implementation, server-side security and authorisation, APIs, frontend implementation (backend-first in later stages), UI/UX quality, testing and progress reporting; **ChatGPT** serves as project management and independent review; **Paul** retains owner decision authority and gate approval. No separate clickable frontend prototype gate is required.

No open owner question blocks local S0 implementation. Implementation itself awaits ChatGPT's freeze of `crm-s0-v2` and Paul's authorisation.

## Contract review closure (`crm-s0-v2`, CR-01 to CR-06)

| Finding | Resolution recorded in `crm-s0-v2.md` and `S0-PLAN.md` | Verified code basis |
|---|---|---|
| **CR-01** Idempotency | Canonical SHA-256 hash covers `{ v: 1, name, via, input, expected }` (omitting blank `reason`, stripping `undefined` keys before `stableJson` due to `shared/stablejson.ts:13-18`); successful no-ops (`already: true`) journal in `crm_commands` with zero audit rows; no errors persisted in S0 (`status = 'ok'`); 16,384 UTF-8 byte cap fails closed (`budget_exceeded`); commit-error recovery enforces `401 -> forbidden -> replay/conflict -> stale -> 503`, prevents masking unrelated SQL constraints, and recovers concurrent fence aborts and lost acks. | `shared/stablejson.ts:4-19`, `worker/idempotency.ts:19-68`, `worker/password.ts` |
| **CR-02** Atomic execution | Dedicated single-batch `flushAtomicCommit` when `opts.commit` is set (zero retries, zero multi-chunking, runs even when `todo` is empty), `strictExpectationGuard` (`LEFT JOIN`) over `expect ∪ changedPlans` (leaving legacy `expectationGuard` intact for `tests/sync-atomic.test.ts:44`), `!authority` `access_state=0` fence, per-record `changes() = 1` SQL assertion aborting server rows on 0-row projection writes, atomic SQL `projections` rev capture, `D1BudgetExhausted`/SQL errors rethrown to recovery. | `worker/sync.ts:42,309,350-365,431-465,515-684`, `tests/sync-atomic.test.ts:44` |
| **CR-03** Authorisation | `crm.access` (`'*'`) is mandatory for `/crm/*`, `/api/crm/read/*` and `/api/crm/commands/*`; specialised grants stay independent rows but have no effect for non-owners while `crm.access` is absent; single-batch authority snapshots (`COALESCE(workspace_role, role)`, never `userByToken`'s `user.role`) on `/status` and `/read/*`; 3 fences on `grant`/`revoke` (`actorFence`, `targetAccountFence`, `targetGrantStateFence`); `pokeLive()` on changes; `crmStatusStore` 6-trigger invalidation matrix. | `worker/auth.ts:199-232`, `worker/admin.ts:19-24,103-105,178`, `src/core/live.ts:75`, `src/core/auth.ts:29-34`, `src/core/accessClient.ts:17-34` |
| **CR-04** API validation | Strict order `401 -> 404 (disabled/unknown + crmApi.all('*') catch-all) -> 413 (streamed 65,536 B cap via boundedRequestBody) -> 400 invalid_body -> 401/forbidden (coarse before parse) -> 200 invalid_input`; wire string schemas map `unknown_capability`/`unknown_scope` cleanly to `CommandError('invalid_input')`; `/read/capability-audit` checks authority before validating base64url `[createdAt, id]` cursor (`400 invalid_cursor`). | `worker/forms.ts:395-403`, `worker/websiteIngest.ts:650-651`, `worker/index.ts:52-56,123-125` |
| **CR-05** Feature flag | `CRM_ENABLED` off hides switcher, disables `/crm/*`, returns `{ enabled: false, access: false, owner, capabilities: [] }` from `/status`, and returns `404` for all other `/api/crm/*` routes (plus `runCommand` guard & unscoped presence path hygiene), while intentionally keeping SC-6 (A-23 owner protection, incl. before `:172` & `:111`), SC-7 (A-25 disable revocation & `DELETE` cleanup) and SC-3 (`_crm_` protection) always active. | `worker/websiteIngest.ts:139-141`, `worker/admin.ts:108-215`, `worker/live.ts:52-57`, `tests/phase7-disable-d1.test.ts:18-136` |
| **CR-06** Single owner & sequencing | Removed Opus-to-Neon shared-contract dependency; Neon authors `shared/crm/capabilities.ts -> projection.ts -> contracts.ts` and validates with `tests/crm-contract.test.ts` + `typecheck` in Stage 1, implements & certifies S0 Backend in Stage 2 (Checkpoint 2 review), builds Stage 3 Frontend against real API, and separates local dev preconditions from production activation checks. | `S0-PLAN.md` sections 2–8, `BACKEND-S0-BRIEF.md` |

## Remainder

**Before S0 implementation starts (Review Gate):**
- Independent ChatGPT review & freeze of [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md). [needs verification]
- Paul's approval of this revised design/plan (`S0-PLAN.md`) and explicit S0 implementation authorisation (commit/push of code remains separately authorised). [needs Paul]

**Before Stage 3 (Frontend UI edits) completes:**
- Capture clean Workspace UX screenshot baselines (`npm run qa:ux -- --record`). [needs execution]

**Before staging / production activation (G4–G6; does NOT block local S0 development):**
- Confirm, on an owner-exported copy of production, that exactly one active account has the `owner` role and that it is Paul's. [needs access]
- SI-01: investigate and stabilise the three flaky Workspace tests before production release (A-24); owner Neon, reviewed by ChatGPT. [needs verification]
- Installed production state: pack installed and its version, People database ID pinned by the website grant, existing People with duplicate emails. [needs access]
- Enable private R2 before channel media at volume. [needs Paul] [needs access]
- Zoho account details (O-20, O-21) and Zoho Mail API verification against Zoho docs and the account before S5. [needs Paul] [needs provider]
- Physical-device and human assistive-technology checks for CRM screens (`docs/architecture/cross-platform-responsive-web.md` section 3). [needs verification]
- Small confirmations still Proposed: time zone `Asia/Kolkata`, open and click tracking off, the name "Conversations". [needs Paul]
- Remaining policy decisions O-04 to O-07, O-09 to O-18 for later slices (`12-OPEN-DECISIONS.md`). [needs Paul]
- Update the `site-patron` branch name in both integration-contract copies at the next website change (C-05). [needs verification]

## Fictional data

All names, emails, amounts and dates in wireframes and examples are fictional and marked as such. None are TCG facts.
