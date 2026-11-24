# TCG CRM — Engineering Progress Checkpoint

This file is the live engineering checkpoint for the TCG CRM project. The canonical decision ledger remains [`01-DECISIONS.md`](01-DECISIONS.md) (decisions are not duplicated here).

## Current Snapshot

| Item | Value |
|---|---|
| **Principal engineering agent** | Neon (T3 Code; revised A-26) |
| **PM & independent review** | ChatGPT |
| **Owner & approver** | Paul |
| **Repository & active branch** | `YHWH3/tcg-workspace`, branch `crm/s0-backend` (branched from reviewed baseline `crm/foundation` @ `8aa6f5300426029dc1db87e979fb871313190973`) |
| **Workspace baseline commit** | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) |
| **Reviewed documentation baseline** | `8aa6f5300426029dc1db87e979fb871313190973` (`crm/foundation`, Checkpoint 1 accepted) |
| **Active contract version** | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) (**Accepted**, superseding `crm-s0-v1`) |
| **Current stage** | **Checkpoint 2 — S0 Backend & Security Review Gate** (Stage 1 Shared Contracts + Stage 2 Backend implemented & verified; awaiting ChatGPT line-by-line review before Stage 3 frontend) |
| **Frontend code changed** | None (`src/` completely untouched) |

---

## Completed Work

1. **Workspace takeover & input archive verification (24 Nov 2026)**
   - Verified clean repository checkout on branch `crm/foundation` at `d1742a09cb1972644ba869134208dc70a76524d7` and Workspace baseline `38c388a`.
   - Verified local confidential archive under `docs/crm/input/` (excluded from git via `docs/crm/.gitignore`; never committed).
   - Audited Workspace baseline test & Worker internals (`worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/idempotency.ts`, `shared/stablejson.ts`, `worker/readAccess.ts`, `worker/forms.ts`, `worker/live.ts`, `worker/historyPersistence.ts`, `src/core/*`, `tests/sync-atomic.test.ts`, `tests/phase7-disable-d1.test.ts`, `scripts/access/selftest.mjs`, `scripts/certification/test-files.mjs`).
2. **Checkpoint 1 — Closed S0 Contract Review findings CR-01 through CR-06 (`crm-s0-v2`, accepted at `8aa6f53`)**
   - Resolved CR-01 through CR-06 in [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md), updated [`01-DECISIONS.md`](01-DECISIONS.md) (revised A-26), [`S0-PLAN.md`](S0-PLAN.md), and [`BACKEND-S0-BRIEF.md`](BACKEND-S0-BRIEF.md).
   - Accepted at Checkpoint 1 (`8aa6f53`) with two non-material implementation clarifications folded into Stage 2:
     - Protected `/api/crm/read/capability-audit?cursor=` preserves `401 -> 404 -> 403 -> 400 invalid_cursor` AND rechecks live session, canonical role, and CRM capabilities in the same D1 `db.batch` snapshot as the returned audit rows.
     - Stage 3 original Workspace screenshot baseline (`npm run qa:ux -- --record`) must be captured from an isolated checkout of `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444`, not from a post-backend-implementation working tree.
3. **Stage 1 — Shared Contracts (`shared/crm/*`, branch `crm/s0-backend`)**
   - Implemented [`shared/crm/capabilities.ts`](../../shared/crm/capabilities.ts) (13 capabilities, labels, scopes, guard).
   - Implemented [`shared/crm/projection.ts`](../../shared/crm/projection.ts) (`_crm_` prefix, `isCrmProjectionKey`, `ProjectionGrant`).
   - Implemented [`shared/crm/contracts.ts`](../../shared/crm/contracts.ts) (`crm-s0-v2` constants, bounds, 15 error codes & `CRM_ERROR_RETRYABLE`, `OWNER_PROTECTED_ERROR`, TypeScript interfaces, and strict Zod schemas).
   - Verified with [`tests/crm-contract.test.ts`](../../tests/crm-contract.test.ts) (4/4 passing) and `npm run typecheck`.
4. **Stage 2 — S0 Backend Implementation (`migrations/0045_crm_foundation.sql`, `worker/`, `scripts/`, 8 backend test suites)**
   - Added [`migrations/0045_crm_foundation.sql`](../../migrations/0045_crm_foundation.sql) (`crm_commands`, `crm_capability_grants`, `crm_capability_audit` + append-only triggers) and registered its SHA-256 in [`scripts/certification/migrations.json`](../../scripts/certification/migrations.json); updated `RELEASE_MIGRATION_COUNT` / preflight count (44 -> 45), `scripts/access/selftest.mjs`, and `scripts/certification/test-files.mjs` + `test-files.test.mjs`.
   - Implemented [`worker/crm/projection.ts`](../../worker/crm/projection.ts), [`worker/crm/rules.ts`](../../worker/crm/rules.ts), [`worker/crm/commands.ts`](../../worker/crm/commands.ts), [`worker/crm/grants.ts`](../../worker/crm/grants.ts), and [`worker/crm/index.ts`](../../worker/crm/index.ts).
   - Updated [`worker/auth.ts`](../../worker/auth.ts) (`CRM_ENABLED?: string`), [`worker/mutationAccess.ts`](../../worker/mutationAccess.ts) (granted `_crm_` projection exemption on `tasks`), [`worker/sync.ts`](../../worker/sync.ts) (unconditional `_crm_` pre-check, filtered `authExisting` on projection rejections, dedicated single-batch `flushAtomicCommit` with `strictExpectationGuard`, `!authority` fence, `changes() = 1` assertion preserving `historyStatement`, committed `seq` capture), [`worker/admin.ts`](../../worker/admin.ts) (always-on SC-6 owner protection + `protectOwner` fence, always-on SC-7 disable revocation + explicit `DELETE` grant cleanup), and [`worker/index.ts`](../../worker/index.ts) (mounted `/api/crm` before `/api` admin).
   - Added all 8 Stage 2 test suites proving every SC-1 through SC-9 requirement and N1 atomic-execution/concurrency proof on real local Miniflare D1.

---

## Backend-First S0 Execution Plan

| Stage | Scope | Status / Gate |
|---|---|---|
| **Stage 0** | ChatGPT reviews & freezes `crm-s0-v2.md`; Paul authorises Stage 1–2 implementation | **Complete (Checkpoint 1 @ `8aa6f53`)** |
| **Stage 1** | `shared/crm/capabilities.ts` -> `projection.ts` -> `contracts.ts` + `tests/crm-contract.test.ts` & `typecheck` | **Complete (4/4 passing)** |
| **Stage 2** | `migrations/0045_crm_foundation.sql`, `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/crm/*`, certification scripts, 8 backend test suites | **Complete — awaiting Checkpoint 2 review** |
| **Stage 3** | Capture `npm run qa:ux -- --record` baseline from isolated `38c388a` checkout; implement `src/routes.tsx`, `AppSwitcher.tsx`, `crmStatus.ts`, `CrmShell.tsx`, `AccessSettings.tsx`, `crm.css`, `scripts/crm-demo/*`, `scripts/ux-lab/crm-shell.spec.mjs` | Not started (blocked on Checkpoint 2) |
| **Stage 4** | Full S0 integration, `npm test` (A-24), `qa:ux` (off: 0 diff pixels; `--crm`: 18 projects + axe + WCAG 2.2 AA), `demo:crm -- --check`, keyboard walkthrough | Not started (Checkpoint 3) |

---

## Next Action

**Stop at Review Gate (Checkpoint 2).** Present branch `crm/s0-backend` and the exact diffs of `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/index.ts`, `worker/auth.ts`, `worker/crm/*`, `shared/crm/*`, and `migrations/0045_crm_foundation.sql` to ChatGPT for independent backend & security review before starting Stage 3 frontend implementation.

---

## Blockers & Open Items

- **Next gate (Checkpoint 2):** ChatGPT line-by-line backend & security review of `crm/s0-backend` and authorisation to proceed to Stage 3 frontend.
- **Later-slice / production blockers (do NOT block local S0 development):**
  - Production owner verification on an owner-exported D1 copy before remote activation (`S0-PLAN.md` section 5.2).
  - Stabilisation of pre-existing flaky test group **SI-01** (`phase4-events-d1`, `phase8-commitments-d1`, `phase8-form-operations-d1`) before production release (`12-OPEN-DECISIONS.md`).
  - Open policy/provider decisions **O-04–O-07, O-09–O-18, O-20–O-21** (`12-OPEN-DECISIONS.md`).

---

## Verification Evidence

- **Stage 1 & Stage 2 targeted suites + regressions (24 Nov 2026, `crm/s0-backend`):**
  - `tests/crm-contract.test.ts` (4), `tests/crm-rules.test.ts` (5), `tests/crm-projection-keys-d1.test.ts` (12), `tests/crm-mcp-projection-d1.test.ts` (2), `tests/crm-commands-d1.test.ts` (6), `tests/crm-grants-d1.test.ts` (4), `tests/crm-disable-revocation-d1.test.ts` (6), `tests/admin-owner-protection-d1.test.ts` (6), `tests/crm-api-d1.test.ts` (5) — **50/50 new S0 tests passed** across 9 files.
  - `tests/sync-atomic.test.ts` (6/6 passed), `tests/phase7-disable-d1.test.ts` (19/19 passed).
- **Full test suite under A-24 (`npm test`):** **227/227 files passed, 2,280/2,280 tests passed (0 failed, 0 skipped)** — baseline 2,230 + 50 new S0 tests (all three SI-01 tests also passed in this run; zero SI-01 tests modified, skipped, or given longer timeouts).
- **Typecheck & production build:** `npm run typecheck` passed (0 errors); `npm run build` passed cleanly (worker + client + SW).
- **Local migration & certification gates:**
  - `npm run db:migrate:local` applied all 45 migrations including `0045_crm_foundation.sql` cleanly on local D1.
  - `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs` passed 100% (migration manifest 45 hashes, D1 test-file partition, preflight, rehearsal, and restricted access selftest).
- **Demo regression check:** `npm run demo:studio -- --check` passed (`Seeded 36 records and 19 views. Studio demo checks passed.`).
- **Not run (out of scope for Stage 1–2 / Checkpoint 2):** Stage 3 frontend (`src/` untouched), `npm run qa:ux`, `npm run demo:crm -- --check`, physical device/iOS Safari/screen-reader checks, remote migrations, production deployment.
