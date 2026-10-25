# Release track R — accept, fix, ship

Goal: production runs the integrated source with correct dashboards. Sol does
R0 and R1 and prepares R2; the owner executes R3.

## R0 — Finish acceptance of the base (blocking)

**Execution refresh (2026-10-25):** `528b889` has a complete resumed PASS
certificate and passing Safari simulator evidence; see 00-baseline §3 and
BASE-EVIDENCE.json. Preserve earlier failed attempts. D1 still selects the
release target; R1 needs its own source-bound verification if selected.

**Steps**
1. Confirm `/Users/trinity/.codex/worktrees/website-workspace-integration/notion mock`
   is clean at `528b889` and no QA process is running (`ps` for `certify`,
   `vitest`, `playwright`, `workerd`, `emulator`).
2. Ask the owner to keep the Mac plugged in, lid open and awake for the run.
   Keep the existing `caffeinate -d -i -s` wrapper and the 90-second host-pause
   abort. Run nothing else heavy concurrently: no emulators and no UX matrix
   during the certificate.
3. Confirm network access to `registry.npmjs.org` before starting; the security
   gate needs `npm audit`.
4. Run `npm run certify:ai`. If D1 decides the base is R1's head, run it there
   instead (see R1 §6).
5. Then run native Safari journeys on the same head (Apple Simulator profiles as
   in `docs/integration-release/QA-TOOLS.md`).
6. Record the decision, fingerprint and gate table in the ledger. Rerun only
   failed stages if the orchestrator supports it; otherwise run the full
   certificate again. Never relabel.

**Done when:** a `…-complete` certificate on the chosen head says PASS 34/34,
the Safari journeys pass, and both are recorded.

## R1 — Relative-date fix (N01, release blocker for dashboards)

Branch `sol/r1-date-window` from `plan/next-phases` (the docs-only commit on top
of `528b889`). Open it as a draft PR based on `plan/next-phases`, or on
`codex/website-workspace-integration` if the plan branch is not published.
Do not push to PR #14.

### 1. Contract

Filter values (and automation conditions, which use the same `evalFilter`) may
be:
- an ISO date `yyyy-mm-dd`;
- `today`;
- `today+N` or `today-N`, where N is an integer from 0 to 3650, with no spaces
  and case-sensitive. These are relative days in the context's `today`.

Anything else is a literal value, matching current behaviour for text fields.

### 2. Implementation

- `shared/dates.ts`: add
  `export function resolveRelativeDate(value: unknown, today: string | undefined): unknown`.
  - It returns `addDays(today, ±N)` for a valid `today±N` and `today` for `'today'`.
  - It returns the input unchanged for anything else.
  - It returns the input unchanged when `today` is missing or invalid; do not
    guess a date.
  - Use the existing `addDays` and `parseDateOnly`.
- `shared/views.ts:200`: replace `if (want === 'today' && ctx.today) want = ctx.today;`
  with `want = resolveRelativeDate(want, ctx.today);`.
- **Fail closed for unresolvable relative values.** If `want` still matches
  `/^today[+-]\d+$/` after resolution (because `ctx.today` is missing), the
  temporal ops (`before`, `after`, `on_or_before`, `on_or_after`) return `false`,
  not a text comparison.
- **Validation.** In `shared/automations.ts` `validateAutomation` and in MCP
  `add_view` / `update_view` validation, reject `today±N` with N > 3650 or
  malformed variants such as `today + 3` or `Today+3`. Return an error string;
  do not silently store them.
- **UI.**
  - In `FilterRow` (`src/core/views/DatabasePage.tsx:582`), when the chosen key
    is a date key, change the free-text placeholder from "value" to
    "yyyy-mm-dd or today±N".
  - Add a short `aria-describedby` help text.
  - Add the same hint in the automation condition editor
    (`src/modules/automations/index.tsx`).
  - No new picker yet; Phase 7.1 adds one.

### 3. Tests

- `tests/dates.test.ts`: resolution for `today`, `today+0`, `today+30`,
  `today-7`, month and year rollover, leap day, N=3650, N=3651 (unchanged and
  invalid), missing today, and malformed values.
- `tests/views.test.ts`:
  - The exact N01 reproduction with `today = 2026-10-24`: 2026-10-30 is true;
    2027-12-31 and 2099-01-01 are false.
  - A metric `aggregate` over Opportunities using the pack's exact filters.
  - The unresolvable relative value fails closed.
- `tests/automations.test.ts`: a condition with `today+14` matches and does not
  match correctly; validation rejects malformed values.
- An MCP parity test: `query_records` with a `today+30` filter returns the same
  ids as `aggregate` for the same `today`.

### 4. Behaviour of existing installs

The pack's stored filters already say `today+30`. Fixing the evaluator corrects
every existing install with no data migration. State this in the PR.

### 5. Out of scope

Timezone unification (7.2), `createdAt` (7.1) and the date picker (7.1).

### 6. Certification choice (owner decision D1)

Recommended: make R1 the head that R0 certifies. It is a small, isolated change,
and certifying it once avoids a second full run. If the owner prefers, certify
`528b889` first and R1 afterwards.

## R2 — Release preparation (Sol builds; owner runs)

Sol prepares scripts and docs only.

1. **`scripts/prod-copy-rehearsal.mjs`.**
   - Input: a SQL dump the owner exports from production (owner command below).
   - It loads the dump into a fresh local D1 (Miniflare) and applies migrations
     0004–0034, plus 0035+ only if they are part of the release.
   - It then runs integrity checks:
     - record counts unchanged;
     - `records` JSON valid;
     - search and date backfills runnable;
     - `access_state.enabled=0`;
     - the two legacy OAuth grants reported as needing reauthorization.
   - Output: a JSON report.
   - It must refuse to run against anything except a local file path.
2. **`docs/roadmap/RELEASE-RUNBOOK.md`.** Merge `docs/integration-release/RUNBOOK.md`
   (Website relay ordering) with the 1.0 launch handoff steps into one ordered
   checklist, with a verification command after each step and a rollback note.
   It must include:
   - backup and export of the production D1 and the relay D1, with a restore
     test on a copy;
   - the rehearsal in step 1;
   - a temporary staging Worker, D1 and KV (owner creates) with a full smoke and
     `verify-*` run against staging;
   - production migrations, then deploy, then secrets (`TURNSTILE_*`,
     `WEBSITE_INGEST_SECRET`, `AI_CREDENTIAL_KEY` only if the assistant's
     bring-your-own-key option is wanted), then confirming the cron is active;
   - creating the Website ingest grant (Settings → Admin), deploying the relay
     with forwarding OFF, then ON, then one real test submission;
   - reconnecting the Claude and ChatGPT connectors;
   - keeping permissions, AI providers, Workers AI and payments OFF.
3. **Merge order** for the owner: #12 → #13 → #14 → R1, retargeting each PR to
   `main` after its base merges. Re-run `npm run certify:ai` on `main` after the
   final merge, before deploying.

## R3 — Owner executes the release

Owner-only. Sol may answer questions and fix release-blocking defects on a new
branch.

Owner commands (for reference; Sol never runs them):
```
npx wrangler d1 export workspace-db --remote --output prod-backup.sql
npx wrangler d1 migrations apply workspace-db --remote
npx wrangler deploy
```

**Done when:**
- production's version id is the merged `main`;
- `d1_migrations` has 34 or more rows;
- a website submission appears in the Website inbox;
- the connectors are reconnected.
