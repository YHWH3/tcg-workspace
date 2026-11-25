# TCG CRM — Engineering Progress Checkpoint

This file is the live engineering checkpoint for the TCG CRM project. The canonical decision ledger remains [`01-DECISIONS.md`](01-DECISIONS.md) (decisions are not duplicated here).

## Current Snapshot

| Item | Value |
|---|---|
| **Principal engineering agent** | Neon (T3 Code; revised A-26) |
| **PM & independent review** | ChatGPT |
| **Owner & approver** | Paul |
| **Repository & active branch** | `YHWH3/tcg-workspace`, branch `crm/s0-frontend` (branched from verified Stage 2 backend `crm/s0-backend` @ `98938ecb10164f705223615cbc42cc0c65d20bc8`) |
| **Workspace baseline commit** | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) |
| **Reviewed documentation baseline** | `8aa6f5300426029dc1db87e979fb871313190973` (`crm/foundation`, Checkpoint 1 accepted) |
| **Active contract version** | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) (**Accepted**, superseding `crm-s0-v1`) |
| **Current stage** | **N3 — Stage 3 Frontend Review Checkpoint** (Stage 3 frontend, Commons demo, UX lab spec, and frontend unit suites complete & verified; awaiting frontend review & N4 full-matrix certification) |
| **Frontend scope delivered** | Shared `AppSwitcher`, `crmStatusStore` (SC-2.3), lazy `CrmShell`, `Home` empty state, `AccessSettings` (Accounts, Capabilities, History), scoped `crm.css`, `demo:crm`, UX lab `--crm` integration |

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
   - Passed Checkpoint 2 ChatGPT review at `98938ecb10164f705223615cbc42cc0c65d20bc8` (including N2 session expiry fence & atomic false-success protection).
5. **N3 — Stage 3 Frontend Implementation (25 Nov 2026, branch `crm/s0-frontend`)**
   - **Isolated Workspace baseline capture (`38c388a`)**: Recorded `.artifacts/ux-lab/baselines/` from a detached worktree of `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`provenance.json` confirms `source.sha = 38c388a...`). All **12 desktop & tablet projects** recorded `website-inbox.png` cleanly. Note: on unmodified `38c388a`, all **6 compact (`390x844`) projects** fail a pre-existing Workspace axe `target-size` check on `src/core/views/DatabasePage.tsx:402` (`.min-w-9` view options button overlapped by `+ View`); left untouched per S0 boundaries.
   - **Core switching, status & routing**:
     - Added [`src/core/crmStatus.ts`](../../src/core/crmStatus.ts): in-memory-only `crmStatusStore` bound to `(uid, token, accessClientStore.epoch, generation)` implementing all 6 SC-2.3 refresh/invalidation triggers (`ws_crm_status_update` storage hint, `ws-records-changed`, `focus`/`pageshow`/`visibilitychange`, WebSocket reconnect, `401 -> dropSession()`, `403`/`404`/`forbidden` synchronous state clearing, offline/online handling).
     - Added [`src/core/AppSwitcher.tsx`](../../src/core/AppSwitcher.tsx): accessible APG menu button (`Workspace` / `CRM`, `Escape` focus return, `window` capture phase so nested mobile drawer `Sheet` stays open), rendering the exact Workspace fallback when `CRM_ENABLED` is off or `crm.access` is absent.
     - Updated [`src/core/shell.tsx`](../../src/core/shell.tsx) (logo slot wrapped in `<AppSwitcher />`), extracted [`src/routes.tsx`](../../src/routes.tsx) with lazy `crm/*` route, and simplified [`src/App.tsx`](../../src/App.tsx).
   - **Scoped CRM shell, Home & Settings**:
     - Added [`src/apps/crm/crm.css`](../../src/apps/crm/crm.css): all selectors strictly scoped under `[data-app="crm"]` / `.dark [data-app="crm"]` using `08-UX-SPEC.md` §4 tokens; bundled as a separate CSS chunk.
     - Added [`src/apps/crm/api.ts`](../../src/apps/crm/api.ts): `runCrmCommand` with `REQUEST_ID_PATTERN` IDs, verbatim `requestId` retry on `503 write_interrupted` / `processing_budget` / transient network drops, Zod response validation, auth failure clearing, and exhaustive SC-4/SC-5/SC-6 error mapping.
     - Added [`src/apps/crm/CrmShell.tsx`](../../src/apps/crm/CrmShell.tsx), [`src/apps/crm/routes.tsx`](../../src/apps/crm/routes.tsx), and [`src/apps/crm/Home.tsx`](../../src/apps/crm/Home.tsx): exposes only S0 modules (Home empty state + Settings for capability managers), enforces SC-9 presence privacy (`sendHere('/')`), handles loading/offline/error/access-denied states, and adapts cleanly across desktop, tablet, and mobile.
     - Added [`src/apps/crm/settings/AccessSettings.tsx`](../../src/apps/crm/settings/AccessSettings.tsx): ARIA tablist (`Accounts`, `Capabilities`, `History`) with URL-persisted tab/account state across reconnect barriers, live polite announcements, owner protection (`—` on owner row), seat counter, invite management, non-optimistic `role="switch"` toggles, inactive specialised grants warning (`effectiveAccess: false`), dormant `crm.capabilities.manage` handling, offline disabled switches, mobile full-screen capability sheet with focus return, and cursor-paged append-only History.
   - **Demo fixture, UX lab & frontend unit suites**:
     - Added `demo:crm` in [`package.json`](../../package.json), [`scripts/crm-demo/data.mjs`](../../scripts/crm-demo/data.mjs), and [`scripts/crm-demo/preview.mjs`](../../scripts/crm-demo/preview.mjs) (fictional Commons team).
     - Added `--crm` mode in [`scripts/qa-ux.mjs`](../../scripts/qa-ux.mjs), [`scripts/ux-lab/playwright.config.mjs`](../../scripts/ux-lab/playwright.config.mjs), [`scripts/ux-lab/project-isolation.mjs`](../../scripts/ux-lab/project-isolation.mjs), [`scripts/ux-lab/read-recovery.mjs`](../../scripts/ux-lab/read-recovery.mjs), [`scripts/ux-lab/support.mjs`](../../scripts/ux-lab/support.mjs), [`scripts/certification/read-recovery.test.mjs`](../../scripts/certification/read-recovery.test.mjs), and [`scripts/ux-lab/crm-shell.spec.mjs`](../../scripts/ux-lab/crm-shell.spec.mjs).
     - Added [`tests/crm-client-contract.test.ts`](../../tests/crm-client-contract.test.ts), [`tests/crm-routes.test.ts`](../../tests/crm-routes.test.ts), and [`tests/crm-isolation.test.ts`](../../tests/crm-isolation.test.ts).

---

## Backend-First S0 Execution Plan

| Stage | Scope | Status / Gate |
|---|---|---|
| **Stage 0** | ChatGPT reviews & freezes `crm-s0-v2.md`; Paul authorises Stage 1–2 implementation | **Complete (Checkpoint 1 @ `8aa6f53`)** |
| **Stage 1** | `shared/crm/capabilities.ts` -> `projection.ts` -> `contracts.ts` + `tests/crm-contract.test.ts` & `typecheck` | **Complete (4/4 passing)** |
| **Stage 2** | `migrations/0045_crm_foundation.sql`, `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/crm/*`, certification scripts, 8 backend test suites | **Complete (Checkpoint 2 @ `98938ec`)** |
| **Stage 3** | Capture `38c388a` baseline; implement `src/routes.tsx`, `AppSwitcher.tsx`, `crmStatus.ts`, `CrmShell.tsx`, `Home.tsx`, `AccessSettings.tsx`, `crm.css`, `scripts/crm-demo/*`, `scripts/ux-lab/crm-shell.spec.mjs`, frontend unit tests | **Complete — awaiting Frontend Review Checkpoint** |
| **Stage 4 (N4)** | Full S0 integration: full `npm test` (A-24), full 18-project `qa:ux` & `qa:ux -- --crm`, Checkpoint 3 review -> Paul sign-off | Pending (reserved for N4) |

---

## Next Action

**Stop at Frontend Review Checkpoint (N3).** Review `crm/s0-frontend` implementation, targeted UX lab / demo results, and `.artifacts/crm-demo/*.png` screenshots before proceeding to N4 full-suite and 18-project visual regression certification.

---

## Blockers & Open Items

- **Pre-existing `38c388a` compact baseline defect (out of S0 scope):** Unmodified `38c388a` fails axe `target-size` on `src/core/views/DatabasePage.tsx:402` (`.min-w-9` overlapped by `+ View` at 390 px width) across the 6 compact projects (`{chromium,firefox,webkit}-compact-{light,dark}`). All 12 desktop and tablet baseline projects pass and are recorded in `.artifacts/ux-lab/baselines/`.
- **Reserved for N4:** Full 2,295+ Vitest suite under A-24 and full 18-project UX lab matrix (`qa:ux` and `qa:ux -- --crm`).
- **Later-slice / production blockers (do NOT block local S0 development):**
  - Production owner verification on an owner-exported D1 copy before remote activation (`S0-PLAN.md` section 5.2).
  - Stabilisation of pre-existing flaky test group **SI-01** (`phase4-events-d1`, `phase8-commitments-d1`, `phase8-form-operations-d1`) before production release (`12-OPEN-DECISIONS.md`).
  - Open policy/provider decisions **O-04–O-07, O-09–O-18, O-20–O-21** (`12-OPEN-DECISIONS.md`).

---

## Verification Evidence

- **N3 Stage 3 Verification (25 Nov 2026, `crm/s0-frontend`):**
  - **Vitest (targeted frontend + contract):** `tests/crm-client-contract.test.ts` (6), `tests/crm-routes.test.ts` (2), `tests/crm-isolation.test.ts` (3), `tests/crm-contract.test.ts` (4) — **4/4 files, 15/15 tests passed**.
  - **Certification script tests:** `node --test scripts/certification/read-recovery.test.mjs scripts/certification/ux-project-isolation.test.mjs` — **8/8 tests passed**.
  - **Typecheck & Build:** `npm run typecheck` (0 errors) and `npm run build` passed (`CrmShell` code-split into separate JS `62.61 kB` and CSS `6.78 kB` chunks).
  - **Commons Demo:** `npm run demo:crm -- --check` passed (real switcher, `/crm`, Accounts, Capabilities grant/revoke + reload persistence, History, inactive-grant warning, Access Denied, 390 px WebKit mobile + full-screen sheet); screenshots saved under `.artifacts/crm-demo/`.
  - **Targeted `--crm` UX Lab (7 projects):** `chromium-desktop-light`, `chromium-desktop-dark`, `chromium-tablet-light`, `chromium-compact-light`, `chromium-compact-dark`, `firefox-desktop-light`, `webkit-compact-light` — **all 7 projects passed (2/2 specs each)** including keyboard walkthrough, Escape focus return, ARIA tablist/combobox/switch, non-optimistic 503 retry, offline disable/reconnect recovery, live revocation unmount, 320×568 reflow, 200% text scaling, touch targets, and WCAG 2.2 AA axe checks.
  - **Workspace 0-diff spot-check (CRM off):** `npm run qa:ux -- --skip-build --project=chromium-desktop-light --grep "visual reference: website inbox"` passed (0 pixel diffs against `38c388a` baseline).
- **Not run (reserved for N4 or physical devices):**
  - Full `npm test` (2,280+ backend + frontend suite) and full 18-project `qa:ux` / `qa:ux -- --crm` certification.
  - Real physical iPhone/iPad/Android/Windows hardware, native 400% OS zoom, and human assistive-technology (VoiceOver/TalkBack/NVDA) testing.
  - Remote D1 migrations, production `CRM_ENABLED` activation, or deployment.
