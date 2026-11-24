# TCG CRM — Engineering Progress Checkpoint

This file is the live engineering checkpoint for the TCG CRM project. The canonical decision ledger remains [`01-DECISIONS.md`](01-DECISIONS.md) (decisions are not duplicated here).

## Current Snapshot

| Item | Value |
|---|---|
| **Principal engineering agent** | Neon (T3 Code; revised A-26) |
| **PM & independent review** | ChatGPT |
| **Owner & approver** | Paul |
| **Repository & branch** | `YHWH3/tcg-workspace`, branch `crm/foundation` |
| **Workspace baseline commit** | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) |
| **Prior CRM documentation commit** | `d1742a09cb1972644ba869134208dc70a76524d7` |
| **Active contract version** | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) (**Candidate**, superseding `crm-s0-v1`) |
| **Current stage** | **Checkpoint 1 — S0 Contract Review Closure** (awaiting ChatGPT freeze of `crm-s0-v2` + Paul S0 implementation authorisation) |
| **Application code changed** | None (`src/`, `shared/`, `worker/`, `migrations/`, `tests/`, `scripts/` untouched) |

---

## Completed Work

1. **Workspace takeover & input archive verification (24 Nov 2026)**
   - Verified local working directory `/Users/trinity/Desktop/tcg-crm`, branch `crm/foundation`, clean tree at `d1742a09cb1972644ba869134208dc70a76524d7`, and Workspace baseline `38c388a`.
   - Verified local confidential archive under `docs/crm/input/` (`00_READ_ME.md`, `01_MASTER_PROMPT.md`, `02_CRM_CONTEXT_AND_DECISIONS.md`, `03_QUESTIONNAIRE_COVERAGE.md`, and `sources/` including `TCG_MASTER_HANDOFF.md/.pdf`, `TCG_Master_Context_Handover_Nov_2026.md/.pdf`, `TCG_SOURCE_LIBRARY.md`, `pasted.txt`, and `TCG_structured_markdown/`). Confirmed excluded from git via `docs/crm/.gitignore`.
   - Audited Workspace baseline test & Worker internals (`worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/idempotency.ts`, `shared/stablejson.ts`, `worker/readAccess.ts`, `worker/forms.ts`, `worker/live.ts`, `worker/historyPersistence.ts`, `src/core/*`, `tests/sync-atomic.test.ts`, `tests/phase7-disable-d1.test.ts`, `scripts/access/selftest.mjs`, `scripts/certification/test-files.mjs`).
2. **Closed S0 Contract Review findings CR-01 through CR-06 (`crm-s0-v2`)**
   - **CR-01 (Idempotency)**: Specified canonical SHA-256 hashing (`{ v: 1, name, via, input, expected }`, stripping `undefined` keys before `stableJson` to avoid `shared/stablejson.ts:13-18` `undefined -> null`), no-op journalling (`already: true`), error persistence rules (no errors persisted in S0), 16,384-byte result cap (`budget_exceeded`), current-authority replay checks, and commit-error recovery precedence (`401 -> forbidden -> replay/conflict -> stale -> 503`).
   - **CR-02 (Atomic execution)**: Replaced generic retry/chunk assumptions with dedicated single-batch `flushAtomicCommit`, `strictExpectationGuard` (`LEFT JOIN`) over `opts.expect ∪ changedPlans` (preserving legacy `expectationGuard` for `tests/sync-atomic.test.ts:44`), `!authority` `access_state=0` fence, mandatory empty-`todo` execution, per-record `changes() = 1` SQL assertions, atomic SQL `projections` revision capture, and explicit error propagation.
   - **CR-03 (Authorisation)**: Defined `crm.access` as mandatory gate for CRM UI/APIs while preserving explicit non-cascading grant rows (`effectiveAccess`), single-batch read authority snapshots (`COALESCE(workspace_role, role)`, never `userByToken`'s `user.role` at `worker/auth.ts:199-214`), 3 fences on `grant`/`revoke`, `pokeLive()` on changes, and the 6-trigger `crmStatusStore` invalidation matrix.
   - **CR-04 (API validation)**: Resolved wire vs strict schema split (`unknown_capability` / `unknown_scope` -> `200 CommandError('invalid_input')`), exact precedence order (`401 -> 404 -> 413 -> 400 -> 200`, incl. `crmApi.all('*', 404)`), streamed `boundedRequestBody` 65,536-byte limit, and post-authority keyset cursor validation (`LEFT JOIN users`).
   - **CR-05 (Feature flag)**: Clarified `CRM_ENABLED` off hides UI/operational APIs (with defensive `runCommand` guard and unscoped presence path redaction at `worker/live.ts:52-57`) while intentionally keeping A-23 owner protection (before `worker/admin.ts:172` & `:111`), A-25 disable revocation (`|` separator + explicit `DELETE` grant cleanup at `:210-213`), and SC-3 `_crm_` projection rejection active across both permission modes.
   - **CR-06 (Governance & sequencing)**: Updated A-26 (`01-DECISIONS.md`), removed Opus-to-Neon shared-contract blocker and mandatory prototype gate, established single-source `shared/crm/*` Stage 1 sequence, restructured `S0-PLAN.md` and `BACKEND-S0-BRIEF.md` into backend-first Stages 1–4 with Checkpoint 2 backend review, and separated local dev from production preconditions.
3. **Documentation consistency & checkpointing**
   - Created `docs/crm/contracts/crm-s0-v2.md` and `docs/crm/PROGRESS.md`; marked `crm-s0-v1.md` superseded; aligned `00-README.md`, `01-DECISIONS.md`, `06-DATA-MODEL.md`, `07-CONTRACTS.md`, `08-UX-SPEC.md`, `11-ROADMAP.md`, `12-OPEN-DECISIONS.md`, `S0-PLAN.md`, and `BACKEND-S0-BRIEF.md`.

---

## Backend-First S0 Execution Plan

| Stage | Scope | Gate |
|---|---|---|
| **Stage 0 (Now)** | ChatGPT reviews & freezes `crm-s0-v2.md`; Paul approves S0 plan & authorises Stage 1–2 implementation | Checkpoint 1 |
| **Stage 1** | Create `shared/crm/capabilities.ts` -> `shared/crm/projection.ts` -> `shared/crm/contracts.ts` + validate with `tests/crm-contract.test.ts` & `npm run typecheck` | Self-check green |
| **Stage 2** | Implement `migrations/0045_crm_foundation.sql`, `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/crm/*`, certification manifest/script updates, and 8 backend test files; verify A-24 full suite + `typecheck` + `build` + `demo:studio -- --check` | Checkpoint 2 (ChatGPT backend & security review) |
| **Stage 3** | Capture `npm run qa:ux -- --record` baseline; implement `src/routes.tsx`, `AppSwitcher.tsx`, `crmStatus.ts`, `CrmShell.tsx`, `AccessSettings.tsx`, `crm.css`, `scripts/crm-demo/*`, `scripts/ux-lab/crm-shell.spec.mjs` against real Stage 2 API | Self-check + UX lab |
| **Stage 4** | Full S0 integration, `npm test` (A-24), `qa:ux` (off: 0 diff pixels; `--crm`: 18 projects + axe + WCAG 2.2 AA), `demo:crm -- --check`, keyboard walkthrough | Checkpoint 3 (ChatGPT + Paul acceptance) |

---

## Next Action

**Stop at Review Gate (Checkpoint 1).** Send `docs/crm/contracts/crm-s0-v2.md`, `docs/crm/S0-PLAN.md`, `docs/crm/BACKEND-S0-BRIEF.md`, and `docs/crm/01-DECISIONS.md` to ChatGPT for independent contract freeze and Paul's S0 implementation authorisation.

Once authorised, the immediate technical starting point is **Stage 1** (`shared/crm/capabilities.ts` -> `projection.ts` -> `contracts.ts` + `tests/crm-contract.test.ts`), followed directly by **Stage 2** (`migrations/0045_crm_foundation.sql` and `worker/`).

---

## Blockers & Open Items

- **S0 implementation blockers (Review Gate only; zero open owner policy decisions block local S0):**
  1. Independent ChatGPT freeze of `docs/crm/contracts/crm-s0-v2.md`.
  2. Paul's authorisation to start S0 implementation.
- **Later-slice / production blockers (do NOT block local S0 development):**
  - Production owner verification on an owner-exported D1 copy before remote activation (`S0-PLAN.md` section 5.2).
  - Stabilisation of pre-existing flaky test group **SI-01** (`phase4-events-d1`, `phase8-commitments-d1`, `phase8-form-operations-d1`) before production release (`12-OPEN-DECISIONS.md`).
  - Open policy/provider decisions **O-04–O-07, O-09–O-18, O-20–O-21** (`12-OPEN-DECISIONS.md`) and small Proposed defaults (`Asia/Kolkata`, tracking off, "Conversations").

---

## Verification Evidence

- **Baseline run (at `38c388a`, inherited prior to documentation-only changes):** `npm test` 2,227 passed / 3 SI-01 failed (2,230 total, 218 files; all 3 SI-01 files passed individually on isolated rerun), `npm run typecheck` passed, `npm run build` passed, `npm run demo:studio -- --check` passed (`00-README.md`).
- **Doc citation, stale-reference & confidentiality sweep (24 Nov 2026, pre-commit on `crm/foundation`):**
  - Scanned all 18 non-input Markdown files under `docs/crm/`: **434** existing repository path & `path:line` citation checks passed with **0** broken links or out-of-range lines (excluding planned future `shared/crm/*`, `worker/crm/*`, `src/apps/crm/*`, `migrations/0045_*`, `tests/crm-*`, and `scripts/*` artefacts).
  - Stale-reference check (`crm-s0-v1`, obsolete Opus/Neon ownership rules) confirmed only intentional superseded/historical notes remain.
  - Confirmed `git ls-files docs/crm/input/` is empty, `git status` touches only `docs/crm/`, and `git diff --check` passed cleanly.
