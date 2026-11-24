# Backend brief for CRM slice S0 (Neon)

This brief is self-contained: it should be enough to implement the backend part of S0 without any earlier conversation. It summarises; where it and a normative document differ, the normative document wins and the difference should be reported.

**Status: not yet authorised.** Do not start until Paul authorises S0 implementation and ChatGPT has recorded the freeze of contract `crm-s0-v1`. Do not commit or push without separate authorisation. Never run remote migrations, activate Workspace permissions, connect providers or deploy.

## 1. What to read, in order

| # | Document | Why |
|---|---|---|
| 1 | `AGENTS.md` (repository root) | Repository invariants. The ones that bind S0 are in section 4 below |
| 2 | `docs/crm/contracts/crm-s0-v1.md` | **Normative** shared contracts SC-1 to SC-9. You implement against them and may not change them |
| 3 | `docs/crm/S0-PLAN.md`, sections 2, 4, 6, 8, 9 and 10 | Governance, file ownership, the exact backend changes, tests, acceptance rule, rollback |
| 4 | `docs/crm/01-DECISIONS.md`, A-19 to A-26 | Owner decisions behind the contracts |
| 5 | `docs/crm/05-ARCHITECTURE.md`, ADR-03, ADR-04, ADR-10 | Why the data split, projections and capabilities are shaped this way |
| 6 | `docs/crm/00-README.md`, "Verification log" V-01, V-02, V-17 to V-19, and "Baseline test results" | The code facts S0 rests on and the recorded baseline |

`docs/crm/input/` is a local, uncommitted handover folder. Nothing in S0 depends on it.

## 2. Your scope

Backend implementation, the database migration, server-side authorisation, the CRM API, the command infrastructure and backend tests. Precisely:

| Action | File | What |
|---|---|---|
| Add | `migrations/0045_crm_foundation.sql` | Exactly the SQL in contract SC-8 |
| Add | `worker/crm/rules.ts` | Pure capability evaluation and grant-management rules (SC-2 rules 1-8, SC-5 table) |
| Add | `worker/crm/projection.ts` | Pure `projectionRejections(changes, grant?)` (SC-3) |
| Add | `worker/crm/commands.ts` | `defineCommand`, `createCommandRegistry(defs)`, `runCommand` (`S0-PLAN.md` section 6.5) |
| Add | `worker/crm/grants.ts` | Fences, effective-capability reads, `capability.grant` and `capability.revoke`, audit reads |
| Add | `worker/crm/index.ts` | `crmApi` Hono router for SC-4 |
| Change | `worker/sync.ts` | `ApplyOptions.projection` and `.commit`; unconditional `_crm_` pre-check; pass the grant to the authoriser; `commit` statements in `flushPlans` (`S0-PLAN.md` section 6.3) |
| Change | `worker/mutationAccess.ts` | Trailing `projection?` parameter; the `_` rule skips granted `_crm_` keys (section 6.3) |
| Change | `worker/admin.ts` | Owner protection on three routes (SC-6); revocation on disable (SC-7) |
| Change | `worker/index.ts` | Mount `app.route('/api/crm', crmApi)` before `app.route('/api', admin)` (`worker/index.ts:123`) |
| Change | `worker/auth.ts` | `Env.CRM_ENABLED?: string` (SC-9) |
| Change | `scripts/certification/migrations.json` | Register 0045 with its SHA-256 |
| Change | `scripts/access/selftest.mjs` | `:33` must stop hard-coding `0044_history_body_context.sql` as the last migration |
| Change | `scripts/certification/test-files.mjs` | Add `crm` to the D1 selection pattern (`:3`) |
| Add | Backend tests | Section 5 |

You import, never edit: `shared/crm/contracts.ts`, `shared/crm/capabilities.ts`, `shared/crm/projection.ts` (Opus creates them verbatim from the contract document). If you need them before they exist, ask for them through ChatGPT; do not write your own versions.

**Out of scope:** every file under `src/`, `src/App.tsx`, `src/core/shell.tsx`, `scripts/qa-ux.mjs`, `scripts/ux-lab/*`, `scripts/crm-demo/*`, `package.json`, `wrangler.jsonc`, `shared/collections.ts`, `src/core/db.ts`, templates, the website integration contract, any MCP tool, any provider adapter, any CRM table beyond SC-8, and fixing the three SI-01 tests (tracked separately; see section 6).

## 3. The facts S0 depends on (verified at `38c388a`)

1. **The `_` protected-field rule does not run with permissions off.** `authorizeMutations` rejects fields starting with `_` (`worker/mutationAccess.ts:66-67`), but `applyChanges` only calls it when `access_state.enabled = 1` or the request comes from a connector (`worker/sync.ts:352-355`). Production pilots with permissions off (A-19). Hence the unconditional pre-check (SC-3).
2. **`applyChanges` issues no batch when nothing changed** (`worker/sync.ts:553-556`). Hence `commit` and the server-only commit mode.
3. **The fence pattern.** A statement `SELECT CASE WHEN <condition> THEN 1 ELSE json_extract('{','$') END` aborts the whole `db.batch` with "malformed JSON" when the condition is false (examples: `adminSessionFence` and `accountFence` in `worker/admin.ts:19-24,103-105`, `accountBatch` at `:106`).
4. **Only three routes change another account's role or status**: `PATCH /api/users/:id` (`worker/admin.ts:165-179`), `POST /api/users/:id/disable` (`:108-124`), `DELETE /api/users/:id` (`:206-215`). Every other `UPDATE users` is a self-edit (`worker/auth.ts:466-489`, `worker/email.ts:156`, `worker/notificationEmail.ts:222-224`). Today an admin can demote, disable or remove the owner while another owner or admin remains.
5. **Owner identity.** Only the bootstrap signup creates `owner` (`worker/auth.ts:316`); migration 0012 assigned `owner` to the earliest-created admin on older databases (`migrations/0012_phase5_access_foundation.sql:37-39`).
6. **Disable batch** already deletes sessions and revokes connector and website grants in one batch (`worker/admin.ts:111-118`).
7. **D1 budget**: `withD1Budget(env, 45)` (`worker/d1budget.ts:18`).
8. **Auth**: `requireAuth` returns `401 { error: 'unauthenticated' }` (`worker/auth.ts:217-222`); `/api/*` responses are `no-store` (`worker/index.ts:49`).

## 4. Invariants you must keep (from `AGENTS.md`)

- Record writes only through `applyChanges`; command handlers write CRM server-only tables directly and never write `records` by SQL.
- Server-only tables are never added to `COLLECTIONS`.
- A policy refusal is item-wise (the `_crm_` pre-check rejects items, it does not abort the batch).
- One timestamp ordering: the pre-check runs after timestamp healing and restamping (after `worker/sync.ts:350`) and reads only patch keys.
- No module-level mutable state in `worker/`: the command registry is built per request.
- Reads go through the request's read gate (`withReadGate`); unauthorised is reported as missing.
- Every request phase fits 45 D1 binding calls; use `db.batch`, never one call per row.
- Credentials derive grants: capability checks need an active account and a live session at check time; disabling revokes (SC-7).
- AI never holds a capability; `capability.grant` and `capability.revoke` are never MCP tools.
- CRM capability checks never depend on `access_state.enabled`.
- If you edit `wrangler.jsonc` (you should not need to), run `npm run cf-typegen`.

## 5. Tests you own (write them first)

Named and specified in `S0-PLAN.md` section 6.6; the contract-to-test map is at the end of the contract document.

- `tests/crm-projection-keys-d1.test.ts` (fails before your change in disabled mode; that proves fact 1)
- `tests/crm-mcp-projection-d1.test.ts`
- `tests/crm-rules.test.ts`
- `tests/crm-commands-d1.test.ts`
- `tests/crm-grants-d1.test.ts` (include: grant to a disabled account → `account_disabled`; manage to a member → `not_admin`)
- `tests/crm-disable-revocation-d1.test.ts`
- `tests/admin-owner-protection-d1.test.ts` (through the HTTP routes with an admin session; never rely on UI hiding)
- `tests/crm-api-d1.test.ts` (every response validated with the shared zod schemas; SC-9 values off, `1`, `true`, `TRUE`, other)

Follow the existing D1 test pattern (Miniflare with migrations applied; see `tests/phase5-audit-interplay-d1.test.ts:40-70` for setup, including the statement splitter that keeps trigger bodies intact).

## 6. How your work is accepted

1. Your tests pass; `npm run typecheck` and `npm run build` pass.
2. Full `npm test` judged by the A-24 rule (`S0-PLAN.md` section 9.4). Baseline at `38c388a`: 2,230 tests in 218 files, 2,227 passed, 3 failed. The only tolerated failures are the three SI-01 tests with their recorded signatures, each passing when re-run alone with `npx vitest run <file>`. Any other failure, any changed failure behaviour, any reduction in test count, or any skip, removal or timeout change on those three tests blocks acceptance. Do not modify those tests in S0.
3. `npm run demo:studio -- --check` passes.
4. Migration 0045 applies to fresh local D1 (`npm run db:migrate:local`) and the certification migration check passes.
5. ChatGPT reviews your `worker/sync.ts`, `worker/mutationAccess.ts` and `worker/admin.ts` diffs line by line against `S0-PLAN.md` section 6.3 and confirms no other Workspace behaviour changed.

## 7. When something does not fit

Stop work on the affected part and send a change request through ChatGPT: what, why, evidence (file and line, failing test), and the impact on the frontend. Do not change a contract, the architecture or a frontend file to make it fit. Internal choices that leave the contracts and architecture unchanged (helper names, internal structure) need no request.

## 8. What to report

Exact commands run and their counts; per-test results for the A-24 rule including isolated reruns; files changed; anything NOT RUN and why; any discrepancy found between this brief, the contracts and the code.
