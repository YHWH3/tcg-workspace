# TCG CRM — Engineering Progress Checkpoint

This file is the live engineering checkpoint for the TCG CRM project. The canonical decision ledger remains [`01-DECISIONS.md`](01-DECISIONS.md) (decisions are not duplicated here).

## Current Snapshot

| Item | Value |
|---|---|
| **Principal engineering agent** | Neon (T3 Code; revised A-26) |
| **PM & independent review** | ChatGPT |
| **Owner & approver** | Paul |
| **Repository & active branch** | `YHWH3/tcg-workspace`, branch `crm/p1-core` (branched from verified S0 commit `70b8bb1b73a4af23038a3b1d6623205c0dd3a81e`) |
| **Workspace baseline commit** | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) |
| **Reviewed documentation baseline** | `8aa6f5300426029dc1db87e979fb871313190973` (`crm/foundation`, Checkpoint 1 accepted) |
| **Active contract version** | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) (S0 accepted) + `contracts/crm-p1-v1.md` (P1 Core CRM, in progress) |
| **Current stage** | **P1 — Autonomous Cross-Platform Core CRM Implementation (Milestone 1 S1 complete -> advancing into S2 Programmes & Applications)** |
| **Overall P1 status** | **Milestone 0 & Milestone 1 (S1) verified & complete:** closed compact `finance.spec.mjs:46` blocker (`108/108` `chromium-compact-light`); implemented `0046_crm_p1_core.sql` (`46` migrations), `tcg-pack` v12 (`20` databases / `78` views / `38` pages), owner-only audited `user.rename`, S1 normalized endpoints/append-only consent/backfill/duplicates, and responsive People & Organisations views (`10/10` Vitest files / `76/76` tests + `153/153` certification + clean build/typecheck). Advancing into S2 (`S2 -> S3 -> S4 -> S9`). |

---

## Completed Work

1. **Workspace takeover & input archive verification (24 Nov 2026)**
   - Verified clean repository checkout on branch `crm/foundation` at `d1742a09cb1972644ba869134208dc70a76524d7` and Workspace baseline `38c388a`.
   - Verified local confidential archive under `docs/crm/input/` (excluded from git via `docs/crm/.gitignore`; never committed).
2. **Checkpoint 1 — Closed S0 Contract Review findings CR-01 through CR-06 (`crm-s0-v2`, accepted at `8aa6f53`)**
   - Resolved CR-01 through CR-06 in [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md), updated [`01-DECISIONS.md`](01-DECISIONS.md) (revised A-26), [`S0-PLAN.md`](S0-PLAN.md), and [`BACKEND-S0-BRIEF.md`](BACKEND-S0-BRIEF.md).
3. **Stage 1 — Shared Contracts (`shared/crm/*`, branch `crm/s0-backend`)**
   - Implemented [`shared/crm/capabilities.ts`](../../shared/crm/capabilities.ts), [`shared/crm/projection.ts`](../../shared/crm/projection.ts), and [`shared/crm/contracts.ts`](../../shared/crm/contracts.ts).
4. **Stage 2 — S0 Backend Implementation (`migrations/0045_crm_foundation.sql`, `worker/`, `scripts/`, 8 backend test suites)**
   - Implemented [`migrations/0045_crm_foundation.sql`](../../migrations/0045_crm_foundation.sql), `worker/crm/*`, always-on Workspace hardenings in `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, and `/api/crm/*` mount in `worker/index.ts`.
   - Passed Checkpoint 2 ChatGPT review at `98938ecb10164f705223615cbc42cc0c65d20bc8`.
5. **N3 — Stage 3 Frontend Implementation (`e9c01028fb5ccb905494c83154945abae4bd1694`, branch `crm/s0-frontend`)**
   - Implemented [`src/core/crmStatus.ts`](../../src/core/crmStatus.ts), [`src/core/AppSwitcher.tsx`](../../src/core/AppSwitcher.tsx), [`src/core/shell.tsx`](../../src/core/shell.tsx), [`src/routes.tsx`](../../src/routes.tsx), [`src/App.tsx`](../../src/App.tsx), [`src/apps/crm/*`](../../src/apps/crm/CrmShell.tsx), [`scripts/crm-demo/*`](../../scripts/crm-demo/preview.mjs), and frontend unit/isolation/UX tests.
6. **N4 — Final S0 Corrections & Integrated Certification (25 Nov 2026, branch `crm/s0-frontend`)**
   - **Account-bound command retries & stale read discard ([`src/apps/crm/api.ts`](../../src/apps/crm/api.ts), [`src/core/crmStatus.ts`](../../src/core/crmStatus.ts), [`src/apps/crm/settings/AccessSettings.tsx`](../../src/apps/crm/settings/AccessSettings.tsx), [`tests/crm-client-contract.test.ts`](../../tests/crm-client-contract.test.ts)):**
     - `runCrmCommand`, `grantCrmCapability`, and `revokeCrmCapability` capture `(uid, token, accessClientStore.epoch, ws_uid)` via `captureCrmSessionBinding()` before starting retries, build request headers once from the captured token, re-verify `assertSameSession()` before every request, after retry delays, after async responses (`fetch`, `res.text()`, `notifyCrmStatusUpdated`), and before returning outcomes — failing closed with `CrmTransportError('identity_changed', retryable: false)` without ever retrying under a replacement account's credentials.
     - `fetchCrmRead` (`fetchCapabilityOverview`, `fetchCapabilityAudit`) and `callWorkspaceAdmin` re-verify session binding after async `api()` completion/rejection so delayed `200`/`401`/`403` responses never mutate replacement account state or invoke `dropSession()`.
     - Legitimate same-identity retries across network drops and `503 write_interrupted` / `processing_budget` preserve `requestId` and bound token verbatim.
     - `AccessSettings.tsx` clears in-memory protected state immediately on identity change even when the new account also holds `canManage`, and ignores `identity_changed` errors silently.
   - **Automatic remote capability revocation & demotion ([`src/core/crmStatus.ts`](../../src/core/crmStatus.ts), [`scripts/ux-lab/crm-shell.spec.mjs`](../../scripts/ux-lab/crm-shell.spec.mjs)):**
     - Added `CRM_FALLBACK_POLL_MS` (`4_000` ms) foreground authority poll in `startCrmStatus()` active only when CRM is enabled, online, visible, and LiveRoom WebSocket is disconnected (Protocol 3 stops LiveRoom presence in `src/core/sync/engine.ts:390`, creating zero polling overhead when CRM is off or WS is connected).
     - Extended `crm-shell.spec.mjs` with automated tests proving remote `crm.capabilities.manage` revocation and remote `admin -> member` demotion automatically unmount protected Settings into `"You don't have access to this"` without manual Refresh, while retaining manual-Refresh and offline/reconnect recovery checks.
     - Added explicit CRM visual reference assertions (`toHaveScreenshot`, `maxDiffPixels: 0`) for `crm-home.png`, `crm-settings-capabilities.png` (masking dynamic `<time>` paragraph container), and `crm-access-denied.png` across all 18 projects.
   - **Narrow compact Workspace accessibility fix ([`src/core/views/DatabasePage.tsx`](../../src/core/views/DatabasePage.tsx), [`scripts/ux-lab/playwright.config.mjs`](../../scripts/ux-lab/playwright.config.mjs)):**
     - Wrapped `ViewTabMenu` and `+ View` `Popover` in `min-w-0 max-md:shrink-0` in `DatabasePage.tsx`, eliminating the 390 px overlap with `.min-w-9` while leaving tablet/desktop layout (`>= 768px`) byte-identical (`maxDiffPixels: 0` against original `38c388a`).
7. **P1 Milestone 0 — Governance Model & S0 Compact Workspace Blocker Closure (25 Nov 2026, branch `crm/p1-core`):**
   - **Governance & Roadmap ([`11-ROADMAP.md`](11-ROADMAP.md), [`01-DECISIONS.md`](01-DECISIONS.md) A-27, [`08-UX-SPEC.md`](08-UX-SPEC.md), [`07-CONTRACTS.md`](07-CONTRACTS.md)):**
     - Recorded package execution strategy (`P0: S0`, `P1: S1+S2+S3+S4+S9`, `P2: S10`, `P3: S5+S11+S12`, `P4: S6+S7+S8`, `P5: S13`, `P6: S14+S15`), permanent mandatory desktop/tablet/phone cross-platform parity & WCAG 2.2 AA policy, and owner-only audited account rename clarification for S1.
   - **Compact Finance / Database accessibility fix ([`src/core/views/DatabasePage.tsx`](../../src/core/views/DatabasePage.tsx)):**
     - Applied compact-only scroll sizing (`max-md:overflow-y-auto` on the inner database column and `max-md:flex-none max-md:overflow-visible` on the active view wrapper) so expanding `Common Cupboard price and cost` on `390×844` never clips `+ New record` (`TableView.tsx:281`), while keeping tablet and desktop (`>=768px`) untouched.
     - Verified: `npm run qa:ux -- --skip-build --project=chromium-compact-light --project=firefox-compact-light --project=webkit-compact-light --grep "Finance desk: Products database"` passed 3/3; `npm run qa:ux -- --skip-build --grep "visual reference: website inbox"` passed 18/18 at `maxDiffPixels: 0`; full `npm run qa:ux -- --skip-build --project=chromium-compact-light` passed **108/108**. Commit `566615e9471099a33549dd7767705e7d9ce03442`.
8. **P1 Milestone 1 (S1) — People, Organisations, Identity, Consent, Duplicates & Owner Rename (25 Nov 2026, branch `crm/p1-core`):**
   - **Shared Contracts, Pack & Migration ([`contracts/crm-p1-v1.md`](contracts/crm-p1-v1.md), [`migrations/0046_crm_p1_core.sql`](../../migrations/0046_crm_p1_core.sql), [`shared/crm/identity.ts`](../../shared/crm/identity.ts), [`shared/crm/programmes.ts`](../../shared/crm/programmes.ts), [`templates/tcg-pack.json`](../../templates/tcg-pack.json)):**
     - Added P1 operational SQL tables (`crm_endpoints`, append-only `crm_consents` with UPDATE/DELETE triggers, `crm_duplicate_candidates` with canonical ordering `person_a_id < person_b_id`, `crm_programme_profiles`, `crm_channel_accounts`, `crm_conversations`, `crm_messages`, `crm_outbox`, `crm_inbound_events`, `crm_templates`, `crm_facts`) and registered migration #46 across certification manifests (`46` migrations).
     - Upgraded `tcg-pack.json` additively to v12 (`20` databases, `78` views, `38` pages, `db_affiliations`, `db_applications`, `db_activities`, neutral `"Email"` field retention).
   - **Backend & Owner Rename ([`worker/admin.ts`](../../worker/admin.ts), [`worker/crm/read.ts`](../../worker/crm/read.ts), [`worker/crm/identity.ts`](../../worker/crm/identity.ts), [`worker/crm/index.ts`](../../worker/crm/index.ts)):**
     - Added owner-only audited account rename (`PATCH /api/users/:id` `{ name }` -> `403 owner_only` for non-owners, `access_audit` action `user.rename`, owner SQL fence).
     - Implemented `person.add_endpoint`, `person.retire_endpoint`, `person.set_primary_endpoint`, `person.record_consent`, `duplicates.dismiss`, bounded `endpoints.backfill` (`<=50` records, `dryRun` + apply + collision detection), `GET /api/crm/read/person/:id`, and `GET /api/crm/read/duplicates`, all enforcing `withD1Budget(env, 45)`, `ReadGate`, and atomic `_crm_*` projections.
   - **Frontend ([`src/apps/crm/components/CrmGrid.tsx`](../../src/apps/crm/components/CrmGrid.tsx), [`src/apps/crm/components/RecordPanel.tsx`](../../src/apps/crm/components/RecordPanel.tsx), [`src/apps/crm/people/PeopleView.tsx`](../../src/apps/crm/people/PeopleView.tsx), [`src/apps/crm/organisations/OrganisationsView.tsx`](../../src/apps/crm/organisations/OrganisationsView.tsx), [`src/apps/crm/settings/AccessSettings.tsx`](../../src/apps/crm/settings/AccessSettings.tsx)):**
     - Delivered Monday-style accessible `CrmGrid` + compact grouped cards with persisted view columns/widths/group collapse/sort/filter, responsive `RecordPanel` (Overview, Endpoints & Consent, Affiliations, Timeline placeholder + `Open in Workspace`), People directory + Duplicates queue + Backfill flow, Organisations directory, and owner-only Rename control in Accounts settings.
   - **S1 Verification:** `npm run typecheck` (0 errors), `npm run build` passed, `npm run db:migrate:local` applied `0046_crm_p1_core.sql`, `node scripts/_validate-tcg-pack.mjs` passed (`20` databases, `78` views, `38` pages), `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs` passed **153/153**, and targeted Vitest passed **10/10 files, 76/76 tests** (`tests/crm-p1-identity.test.ts`, `tests/crm-p1-identity-d1.test.ts`, `tests/crm-isolation.test.ts`, `tests/admin-owner-protection-d1.test.ts`, `tests/tcg-pack.test.ts`, `tests/views.test.ts`, `tests/phase7-pack-*`, `tests/crm-routes.test.ts`, `tests/crm-client-contract.test.ts`).

---

## Baseline & Screenshot Provenance

| Artifact Set | Source & Method | Coverage | Status |
|---|---|---|---|
| **Original Workspace baselines** (`.artifacts/ux-lab/baselines/`) | Unmodified isolated checkout of `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`fingerprint: 87796aa3f5f95da3ee1aa6f37004690d58da32cea00e0d51373e32429101b1ec`) | 12 desktop & tablet projects (`website-inbox.png` + `provenance.json`) | **Unchanged**; 12/12 pass `maxDiffPixels: 0` |
| **Corrected compact Workspace baselines** (`.artifacts/ux-lab/baselines-compact-a11y-fix/`) | Isolated detached checkout of `38c388a` (`baseFingerprint: 87796aa3...`) + ONLY `src/core/views/DatabasePage.tsx` compact patch (`patchSha256: 7a02a0ae2a79104a8116fa265b0eb35f5e85c0de0c9818db007333ee45638379`) | 6 compact `390×844` projects (`website-inbox.png`, `compact-a11y-fix.patch`, `provenance.json`) | **6/6 pass** `maxDiffPixels: 0` + WCAG 2.2 AA axe |
| **CRM explicit visual baselines** (`.artifacts/ux-lab/crm-baselines/`) | Recorded via `npm run qa:ux -- --crm --record --skip-build` (`2026-11-25T07-52-56.672Z`) and verified independently via `npm run qa:ux -- --crm --skip-build` (`2026-11-25T08-03-52.557Z`) | All 18 projects × 3 PNGs = **54 visual references** (`crm-home.png`, `crm-settings-capabilities.png`, `crm-access-denied.png`) + `provenance.json` | **18/18 projects (36/36 specs) pass** at `maxDiffPixels: 0` |
| **Commons demo screenshots** (`.artifacts/crm-demo/`) | Generated by `npm run demo:crm -- --check` against real Worker + D1 (`CRM_ENABLED=true`) | Light & dark desktop + compact mobile walkthrough screenshots | Passed (`CRM Commons demo checks passed`) |

---

## Backend-First S0 Execution Plan Status

| Stage | Scope | Status / Gate |
|---|---|---|
| **Stage 0** | ChatGPT reviews & freezes `crm-s0-v2.md`; Paul authorises Stage 1–2 implementation | **Complete (Checkpoint 1 @ `8aa6f53`)** |
| **Stage 1** | `shared/crm/capabilities.ts` -> `projection.ts` -> `contracts.ts` + `tests/crm-contract.test.ts` & `typecheck` | **Complete (4/4 passing)** |
| **Stage 2** | `migrations/0045_crm_foundation.sql`, `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/crm/*`, certification scripts, 8 backend test suites | **Complete (Checkpoint 2 @ `98938ec`)** |
| **Stage 3** | Original `38c388a` baseline, `src/routes.tsx`, `AppSwitcher.tsx`, `crmStatus.ts`, `CrmShell.tsx`, `Home.tsx`, `AccessSettings.tsx`, `crm.css`, `scripts/crm-demo/*`, `scripts/ux-lab/crm-shell.spec.mjs`, frontend unit tests | **Complete (`e9c0102`)** |
| **Stage 4 (N4)** | Targeted N4 corrections + full S0 integrated certification gate (`S0-PLAN.md` §8) | **CRM & unit/build/demo gates PASS; full 18-project Workspace `qa:ux` BLOCKED by pre-existing compact `finance.spec.mjs:46` defect (awaiting owner decision at Checkpoint 3)** |

---

## Verification Evidence (25 Nov 2026, `crm/s0-frontend`)

- **Full Vitest suite (`npm test`):** **230/230 files, 2,299/2,299 tests passed** (0 failures, 0 skipped; A-24 SI-01 tolerance not needed). Includes **69 S0 tests across 12 files**:
  - `tests/crm-contract.test.ts` (4)
  - `tests/crm-rules.test.ts` (5)
  - `tests/crm-projection-keys-d1.test.ts` (12)
  - `tests/crm-mcp-projection-d1.test.ts` (2)
  - `tests/crm-commands-d1.test.ts` (8)
  - `tests/crm-grants-d1.test.ts` (6)
  - `tests/crm-disable-revocation-d1.test.ts` (6)
  - `tests/admin-owner-protection-d1.test.ts` (6)
  - `tests/crm-api-d1.test.ts` (5)
  - `tests/crm-client-contract.test.ts` (10 — N4 additions covering retry-delay account switch, epoch bump, delayed 200/401/403 discard, stale protected read discard, same-identity `requestId` reuse, and fallback polling)
  - `tests/crm-isolation.test.ts` (3)
  - `tests/crm-routes.test.ts` (2)
- **Typecheck & Build:** `npm run typecheck` (0 errors) and `npm run build` passed (`CrmShell` code-split into `64.32 kB` JS and `6.78 kB` CSS chunks).
- **Local D1 Migrations & Certification Scripts:**
  - `npm run db:migrate:local` succeeded (`No migrations to apply!`).
  - `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`: **153/153 tests passed**.
- **Demos:**
  - `npm run demo:studio -- --check`: passed (`Seeded 36 records and 19 views`, `.artifacts/studio-demo/run-dxrkOr`).
  - `npm run demo:crm -- --check`: passed (`.artifacts/crm-demo/`).
- **Full 18-Project CRM UX Matrix:**
  - `npm run qa:ux -- --crm --record --skip-build`: **18/18 projects, 36/36 tests expected (`exitCode: 0`)**, capturing 54 explicit baselines under `.artifacts/ux-lab/crm-baselines/`.
  - `npm run qa:ux -- --crm --skip-build`: **18/18 projects, 36/36 tests expected (`exitCode: 0`, `projectsComplete: true`)** with `maxDiffPixels: 0` across all 54 baselines, verifying keyboard navigation, Escape focus return, ARIA tablist/combobox/switch, non-optimistic 503 retry, offline disable/reconnect recovery, automatic remote capability revocation & admin demotion without manual Refresh, retained manual Refresh revocation, 320×568 reflow, 200% text scaling, ≥44×44 touch targets, and WCAG 2.2 AA axe checks across Chromium, Firefox, and WebKit × light and dark × compact, tablet, and desktop.
- **Workspace CRM-off UX Verification:**
  - `npm run qa:ux -- --skip-build --grep "visual reference: website inbox"`: **18/18 projects passed (`exitCode: 0`)** — 12/12 desktop & tablet match unmodified `38c388a` (`maxDiffPixels: 0`); 6/6 compact match `.artifacts/ux-lab/baselines-compact-a11y-fix/` (`maxDiffPixels: 0`, zero axe violations).
  - `npm run qa:ux -- --skip-build --project=chromium-desktop-light`: **108/108 tests passed (`exitCode: 0`)**.
  - `npm run qa:ux -- --skip-build --project=chromium-compact-light`: **107/108 passed**, **1 failed** (`scripts/ux-lab/finance.spec.mjs:46` — see Blockers below).

---

## Blockers & Open Items

1. **Pre-existing compact Workspace accessibility defect (`scripts/ux-lab/finance.spec.mjs:46`, `src/core/views/TableView.tsx:281`) — RESOLVED in P1 Milestone 0:**
   - Closed via compact-only scroll container adjustment in `src/core/views/DatabasePage.tsx`; verified passing on all 3 compact engines (`chromium-compact-light`, `firefox-compact-light`, `webkit-compact-light`), `108/108` full `chromium-compact-light`, and `18/18` `website-inbox` visual regression at `maxDiffPixels: 0`. Full 18-project Workspace `qa:ux` sweep runs in the Milestone 6 P1 certification gate.
2. **Harness transient note:** During two unfiltered multi-project `qa:ux` starts, Wrangler's local dev HTTPS server returned a transient HTTP 500 `Error: Network connection lost.` on `POST /api/approvals` during fixture seeding before subsequent passes succeeded without code changes.
3. **NOT RUN (unavailable / out-of-scope external gates):**
   - Real physical iPhone, iPad, Android, and Windows hardware (Emulated WebKit is not real iOS Safari).
   - Native 400% OS/browser zoom.
   - Human assistive-technology assessment (VoiceOver, TalkBack, NVDA).
   - Remote D1 migrations, production `CRM_ENABLED` activation, or deployment.
4. **Later-slice / production blockers (unchanged, outside S0):**
   - Production owner verification on an owner-exported D1 copy before remote activation (`S0-PLAN.md` section 5.2).
   - Pre-existing **SI-01** test stabilisation and open policy/provider decisions **O-04–O-07, O-09–O-18, O-20–O-21**.
