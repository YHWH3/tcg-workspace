# Backend-first S0 implementation brief (Neon)

This brief is self-contained for executing **Stage 1 (Shared Contracts)** and **Stage 2 (S0 Backend)** once the review gate clears. Where this brief and [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) ever differ, `crm-s0-v2.md` is normative and wins.

**Status: awaiting Review Gate (Checkpoint 1).** Do not begin code implementation until ChatGPT has recorded the freeze of `crm-s0-v2` and Paul has authorised S0 implementation. Never run remote migrations, activate Workspace permissions, connect real providers, deploy or commit secrets. Track progress in [`PROGRESS.md`](PROGRESS.md).

---

## 1. Required reading order

| # | Document | Why |
|---|---|---|
| 1 | `AGENTS.md` (repository root) | Standing repository, D1-budget, security and testing invariants |
| 2 | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) | **Normative** contracts SC-1 to SC-9 (incorporates CR-01 through CR-06) |
| 3 | [`S0-PLAN.md`](S0-PLAN.md) | Backend-first Stages 1–4, exact Workspace code edits, checkpoints, A-24 gate, rollback |
| 4 | [`01-DECISIONS.md`](01-DECISIONS.md) (especially A-19 to A-26) | Approved owner decisions and revised responsibility model |
| 5 | [`05-ARCHITECTURE.md`](05-ARCHITECTURE.md) (ADR-03, ADR-04, ADR-10) | Data split, `_crm_` projection protection, CRM capability model |
| 6 | [`00-README.md`](00-README.md) (Verification log & Baseline results) | Pinned baseline facts (`38c388a`) and recorded test counts |

`docs/crm/input/` is a local git-ignored handover folder; nothing in S0 implementation depends on it, and nothing from it may be committed.

---

## 2. Stage 1 — Shared contract files & validation (do FIRST)

Under revised A-26, **Neon owns `shared/crm/*` as the single source of truth** imported by both `worker/` and (in Stage 3) `src/`. Create and validate these files **before** any `worker/crm/*` or `src/apps/crm/*` file:

1. **`shared/crm/capabilities.ts`**: Exact catalogue (`CRM_CHANNELS`, `CRM_CAPABILITIES`, `ALL_SCOPE`, `CrmScope`, `PROGRAMME_SCOPED`, `isCrmCapability`, `CRM_CAPABILITY_LABELS`). Pure catalogue + UI labels only — zero authorisation logic.
2. **`shared/crm/projection.ts`**: `CRM_PROJECTION_PREFIX = '_crm_'`, `isCrmProjectionKey`, `ProjectionGrant`.
3. **`shared/crm/contracts.ts`**: Exact constants (`CRM_CONTRACT_VERSION = 'crm-s0-v2'`, `REQUEST_ID_PATTERN`, `MAX_COMMAND_BODY_BYTES = 65_536`, `MAX_COMMAND_RESULT_BYTES = 16_384`, `MAX_EXPECTED_ENTRIES = 100`, `AUDIT_PAGE_LIMIT = 50`, `MAX_CAPABILITY_REASON_CHARS = 500`), error codes & `CRM_ERROR_RETRYABLE`, `OWNER_PROTECTED_ERROR`, all TypeScript interfaces, and all Zod schemas (`CommandRequestEnvelopeSchema`, `commandResultSchema`, `CommandErrorSchema`, `CrmStatusSchema`, `CapabilityOverviewSchema`, `CapabilityAuditPageSchema`, wire `CapabilityChangeRequestInputSchema`, strict `CapabilityChangeInputSchema`, `CapabilityChangeOutputSchema`).
4. **Validate immediately**: Write and run `tests/crm-contract.test.ts` + `npm run typecheck`.

---

## 3. Stage 2 — Backend scope & exact edits

| Action | File | Responsibility |
|---|---|---|
| Add | `migrations/0045_crm_foundation.sql` | Exact SQL in `crm-s0-v2.md` SC-8 (`crm_commands` incl. `status` + UTF-8 byte cap `CHECK`, `crm_capability_grants`, `crm_capability_audit` + append-only triggers). |
| Add | `worker/crm/rules.ts` | Pure SC-2 & SC-5 evaluation: owner implicit, `crm.access` mandatory prerequisite over specialised capabilities, `crm.capabilities.manage` + `admin`, 15-step precedence (`not_admin` grant-only). |
| Add | `worker/crm/projection.ts` | Pure `projectionRejections(changes, projection?)` implementing SC-3. |
| Add | `worker/crm/commands.ts` | Per-request `createCommandRegistry(defs)` (validating `projectionKeys` regex, zero module-level state) and `runCommand` (defensive `CRM_ENABLED` check, strip `undefined` before `stableJson`, recovery precedence `401 -> forbidden -> replay/conflict -> stale -> 503`). |
| Add | `worker/crm/grants.ts` | Single-batch loaders (`COALESCE(workspace_role, role)`, never `c.get('user').role`), `actorFence`, `targetAccountFence`, `targetGrantStateFence`, `capability.grant` & `capability.revoke` (`pokeLive()` on change), `readCapabilitiesOverview`, `readCapabilityAudit` (`LEFT JOIN users`). |
| Add | `worker/crm/index.ts` | `crmApi` Hono router (`GET /status`, `POST /commands/:name`, `GET /read/capabilities`, `GET /read/capability-audit`, plus `crmApi.all('*', 404 not_found)`). |
| Change | `worker/sync.ts` | `ApplyOptions.projection` & `.commit`; `ApplyResult.fenceAborted`; unconditional `_crm_` pre-check after `:350`; preserve empty-`todo` commits when `opts.commit` set; pass `opts.projection` to `authorizeMutations`; add single-batch `flushAtomicCommit` (`strictExpectationGuard` `LEFT JOIN`, `!authority` `access_state=0` fence, `changes() = 1` SQL assertion per record write, SQL `json_set` committed `projections`, no retries, rethrow non-fence errors without speculative `readRows`). Keep legacy `expectationGuard` untouched for `tests/sync-atomic.test.ts:44`. |
| Change | `worker/mutationAccess.ts` | Trailing `projection?: ProjectionGrant` on `authorizeMutations`; skip `_` rejection only for matching granted `_crm_` keys on `tasks`. |
| Change | `worker/admin.ts` | Always-on SC-6 owner protection (`403 owner_protected` placed before `:172` and `:111` + `accountFence(..., protectOwner)`); always-on SC-7 disable revocation (`|`-delimited `request_id`, `ORDER BY capability, scope`) + explicit `DELETE FROM crm_capability_grants` on `DELETE /users/:id`. |
| Change | `worker/index.ts` | Mount `app.route('/api/crm', crmApi)` before `app.route('/api', admin)` (`worker/index.ts:123`). |
| Change | `worker/auth.ts` | Add `CRM_ENABLED?: string` to `Env` (`worker/auth.ts:10`). |
| Change | `scripts/certification/migrations.json` | Register `0045_crm_foundation.sql` + SHA-256. |
| Change | `scripts/access/selftest.mjs` | Replace hard-coded `'0044_history_body_context.sql'` at `:33` with `verifyMigrationManifest().at(-1).name`. |
| Change | `scripts/certification/test-files.mjs` & `test-files.test.mjs` | Include `crm` and `admin-owner-protection` D1 test files in `d1TestFiles` (`:3`) and update test assertions. |
| Add | Backend tests (8 files) | Section 6 below. |

**Do NOT touch during Stage 1 & Stage 2:** `src/` (reserved for Stage 3 after Checkpoint 2 backend review), `shared/collections.ts`, `wrangler.jsonc`, `templates/*.json`, `docs/integrations/the-common-ground.md`, or the three SI-01 test files.

---

## 4. Verified code hazards & non-negotiable backend requirements (CR-01 to CR-05)

1. **`applyChanges` permissions-off gap (`worker/sync.ts:352-355`, `worker/mutationAccess.ts:65-68`)**: `authorizeMutations` runs only when `snapshot.enabled === 1 || env.CONNECTOR`. The `_crm_` pre-check MUST run unconditionally right after patch cloning (`:350`) and return early on any rejection when `atomic: true`. `_crm_` keys are already excluded from `record_history` (`worker/historyPersistence.ts:3`).
2. **`applyChanges` `flushPlans` hazards (`worker/sync.ts:309,515-684`) — CR-02**:
   - Line `:309` returns early when `!incoming.length && !opts.expect?.size`.
   - Line `:515-523` `expectationGuard` uses `INNER JOIN` (ignoring missing rows) and `:567` checks only `chunk` (ignoring read-only `opts.expect` IDs and unchanged projections). **AND `tests/sync-atomic.test.ts:44` intercepts `/JOIN json_each\(\?\)/`!** Therefore keep `expectationGuard` intact for existing callers and route `opts.commit` through a dedicated single-batch `flushAtomicCommit` using `strictExpectationGuard` (`LEFT JOIN ... WHERE COALESCE(r.seq, -1) <> e.value`) over `opts.expect ∪ changedPlans`.
   - `flushAtomicCommit` MUST run even when `changedPlans` is empty (unchanged projections / read-only `expect`), MUST assert `SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END` immediately after every record upsert so a 0-row projection aborts server-only rows + journal, MUST capture committed `seq` into `crm_commands.result` inside SQL, MUST NOT retry or split chunks, MUST preserve `D1BudgetExhausted`, and MUST rethrow non-fence errors to `runCommand` instead of returning `partialError`.
3. **Canonical hashing & journal recovery (`shared/stablejson.ts:4-19`, `worker/password.ts`) — CR-01**:
   - **Watch out for `shared/stablejson.ts:13-18`:** `sortValue(undefined)` returns `null`, so `stableJson({ a: 1, reason: undefined })` emits `{"a":1,"reason":null}`! Recursively strip `undefined` object properties in `worker/crm/commands.ts` before calling `stableJson`, hash `{ v: 1, name, via, input: canonicalInput, expected: canonicalExpected }` with `sha256Hex(stableJson(...))` (never `argsHash()`), and keep `shared/stablejson.ts` untouched.
   - Persist `crm_commands` for every committed `ok: true` result, **including successful `already: true` no-ops** (zero audit rows). Persist **zero** errors in S0 (`status = 'ok'`). Enforce `<= 16,384` UTF-8 bytes before commit (`budget_exceeded` on overflow, never truncate).
   - On ANY commit error (except `D1BudgetExhausted`, which rethrows for `503 processing_budget`), execute a recovery read batch for `(actor_id, request_id)` + current actor session/role/grants:
     - Enforce precedence: dead session/disabled actor -> `401`; lost actor authority -> `200 forbidden`; existing `crm_commands` row -> check hash (`idempotency_conflict`) or `authorizeReplay` -> return stored result verbatim (recovers both lost acks AND concurrent winner-tripped-fence races!); absent journal -> `stale` on fence abort, 500/domain-map on unrelated SQLite constraints, `503 write_interrupted` on transient D1 error.
4. **Auth & read snapshots (`worker/auth.ts:199-232`, `worker/admin.ts:19-24,103-105`) — CR-03**:
   - `userByToken` (`:199-214`) returns only `u.role` (never `workspace_role`), and `requireAuth` post-check (`:227-232`) rechecks only `sessions` and `disabled_at` on `GET`/`HEAD`, not role or CRM capability grants. Never inspect `c.get('user').role`; load `COALESCE(u.workspace_role, u.role)` + grants + payload in ONE `db.batch` snapshot on `/status` and `/read/*`.
   - Non-owners require `crm.access` (`'*'`) for EVERY `/api/crm/read/*` and `/api/crm/commands/*` route; no specialised capability is effective without `crm.access` (`'*'`).
   - `capability.grant` / `revoke` batches MUST include all 3 fences (`actorFence`, `targetAccountFence`, `targetGrantStateFence`), even on `already: true` no-ops, and call `pokeLive()` on state change.
5. **Request validation order & streamed body cap (`worker/forms.ts:395-403`) — CR-04**:
   - Exact order: `401` (`requireAuth`) -> `404` (`CRM_ENABLED` off / unknown command; plus `crmApi.all('*', 404 not_found)`) -> `413 request_too_large` (`boundedRequestBody(c.req.raw, 65_536)`) -> `400 invalid_body` (strict UTF-8 + JSON + `CommandRequestEnvelopeSchema`) -> `401` / `200 forbidden` (coarse authority) -> `200 invalid_input` (wire schema, then `unknown_capability`, then `unknown_scope`) -> `200 forbidden` (fine capability) -> idempotency check -> load/plan -> atomic commit.
   - Audit cursor validated ONLY after `401` / `404` / `403` authority check passes; rejects empty string, >256 chars, bad base64url/JSON/bounds with `400 invalid_cursor`. Uses `LEFT JOIN users`.
6. **Always-on Workspace controls (`CRM_ENABLED` off) — CR-05**:
   - When `CRM_ENABLED` is off, operational `/api/crm/*` routes return `404` (after `401`) and `/status` returns `enabled: false, access: false, owner, capabilities: []`, while SC-6 (A-23), SC-7 (A-25), and SC-3 (ADR-04) stay **active**.
   - Verified compatibility with `tests/phase7-disable-d1.test.ts` (45-call budget at `:24`, all existing callers act as owner on non-owners).

---

## 5. Preconditions distinction (`CR-06`)

- **Local S0 dev**: needs only frozen `crm-s0-v2` + Paul's S0 implementation approval. Local D1 fixtures bootstrap a single active `owner` automatically (`worker/auth.ts:316`).
- **Production activation**: reading an owner-exported prod D1 copy to verify the single active `owner` is Paul (and stabilising SI-01) is required **before production rollout / G4–G6** — it does **not** block Stage 1–4 local development.

---

## 6. Stage 1 & Stage 2 tests & Checkpoint 2 acceptance

Write and verify these 9 test files (listed in full detail in [`S0-PLAN.md`](S0-PLAN.md) section 6.4):
- Stage 1: `tests/crm-contract.test.ts`
- Stage 2: `tests/crm-projection-keys-d1.test.ts`, `tests/crm-mcp-projection-d1.test.ts`, `tests/crm-rules.test.ts`, `tests/crm-commands-d1.test.ts`, `tests/crm-grants-d1.test.ts`, `tests/crm-disable-revocation-d1.test.ts`, `tests/admin-owner-protection-d1.test.ts`, `tests/crm-api-d1.test.ts`.

**Checkpoint 2 passes only when:**
1. Stage 1 & Stage 2 tests pass; `npm run typecheck` and `npm run build` pass.
2. Full `npm test` passes under **A-24** (tolerating ONLY the 3 unchanged SI-01 signatures with passing isolated `npx vitest run <file>` reruns; total tests `>= 2,230 + new S0 tests`; zero skipped/modified SI-01 tests).
3. `npm run demo:studio -- --check` passes.
4. `npm run db:migrate:local` applies `0045` cleanly on fresh D1 and certification migration/test-file checks pass (`node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`).
5. ChatGPT finishes line-by-line review of `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/index.ts`, and `worker/auth.ts` before Stage 3 frontend implementation begins.
