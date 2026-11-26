# TCG CRM — Engineering Progress Checkpoint

This file is the live engineering checkpoint for the TCG CRM project. The canonical decision ledger remains [`01-DECISIONS.md`](01-DECISIONS.md) (decisions are not duplicated here).

## Current Snapshot

| Item | Value |
|---|---|
| **Principal engineering agent** | Neon (T3 Code; revised A-26) |
| **PM & independent review** | ChatGPT |
| **Owner & approver** | Paul |
| **Repository & active branch** | `YHWH3/tcg-workspace`, branch `crm/p3-communications` (branched from `crm/p2-integrity` commit `6ef8ab645a9b3e0f15e0bce3f01893809598b7cf`) |
| **Workspace baseline commit** | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) |
| **Reviewed documentation baseline** | `8aa6f5300426029dc1db87e979fb871313190973` (`crm/foundation`, Checkpoint 1 accepted) |
| **Active contract version** | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) + [`contracts/crm-p1-v1.md`](contracts/crm-p1-v1.md) + [`contracts/crm-p2-v1.md`](contracts/crm-p2-v1.md) + [`contracts/crm-p3-v1.md`](contracts/crm-p3-v1.md) (P3 / S5 + S11 + S12) |
| **Current stage** | **P3 — Communications & Targeted P2 Hardening (Complete & Core-Verified on `crm/p3-communications`, Stopped at P3 Review Boundary)** |
| **Overall P3 status** | **P3 Implementation Complete (`a7d0700`..`2484fd4`):** All 6 P2 independent review findings closed & committed separately (`352b9c1`); A-28 risk-based testing strategy recorded (`a7d0700`); migration `0048_crm_communications.sql` + contract `crm-p3-v1.md` + S5 Zoho Mail, S11 WhatsApp Cloud, S12 Instagram/Facebook adapters & signed webhooks + responsive Channels/Templates/Delivery Review & Inbox UI implemented (`7b8e12a`..`0ec5a01`); verified via `32/32` CRM & adjacent Workspace Vitest suites (`187/187`), `153/153` certification selftests, `17/17` `release:preflight`, `verify-p3-communications.mjs`, Studio demo, and CRM demo (`29` desktop/tablet/mobile screenshots, `p2MergeVerified: true`, `p3CommunicationsVerified: true`). Real provider connections remain disabled; comprehensive 18-project browser matrices remain deferred to P4 and P6 per A-28. |

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
   - **S1 Verification:** `npm run typecheck` (0 errors), `npm run build` passed, `npm run db:migrate:local` applied `0046_crm_p1_core.sql`, `node scripts/_validate-tcg-pack.mjs` passed (`20` databases, `78` views, `38` pages), `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs` passed **153/153**, and targeted Vitest passed **10/10 files, 76/76 tests** (`tests/crm-p1-identity.test.ts`, `tests/crm-p1-identity-d1.test.ts`, `tests/crm-isolation.test.ts`, `tests/admin-owner-protection-d1.test.ts`, `tests/tcg-pack.test.ts`, `tests/views.test.ts`, `tests/phase7-pack-*`, `tests/crm-routes.test.ts`, `tests/crm-client-contract.test.ts`). Commit `4bdd470`.
9. **P1 Milestone 2 (S2) — Programmes, Enquiries, Applications, Timeline & Scoped Capabilities (25 Nov 2026, branch `crm/p1-core`):**
   - **Scoped Capabilities & Contracts ([`shared/crm/contracts.ts`](../../shared/crm/contracts.ts), [`shared/crm/programmes.ts`](../../shared/crm/programmes.ts), [`shared/crm/projection.ts`](../../shared/crm/projection.ts), [`worker/crm/rules.ts`](../../worker/crm/rules.ts)):**
     - Enabled `programme:<slug>` scopes strictly for `PROGRAMME_SCOPED` (`crm.restricted.read`, `crm.configure`), rejecting unknown slugs and programme scopes on non-scoped capabilities with `unknown_scope`.
     - Added typed `CRM_PROJECTION` constants and S2 wire schemas (`UpdateProgrammeProfile`, `CreateApplicationFromSubmission`, `ConvertApplication`, `Timeline`, `HomeSummary`).
   - **Backend ([`worker/crm/programmes.ts`](../../worker/crm/programmes.ts), [`worker/crm/applications.ts`](../../worker/crm/applications.ts), [`worker/crm/index.ts`](../../worker/crm/index.ts)):**
     - Implemented `programme.update_profile` (scoped `crm.configure` + optimistic `rev` SQL fence + `db_programs` projections), `application.create_from_submission` (strictly read-only against immutable Website inbox submissions), `application.convert` (Project / Opportunity / Event with atomic links), `GET /api/crm/read/programmes`, keyset-paginated `GET /api/crm/read/timeline`, and `GET /api/crm/read/home` v1.
   - **Frontend ([`src/apps/crm/programmes/ProgrammesView.tsx`](../../src/apps/crm/programmes/ProgrammesView.tsx), [`src/apps/crm/applications/ApplicationsView.tsx`](../../src/apps/crm/applications/ApplicationsView.tsx), [`src/apps/crm/settings/ProgrammesSettings.tsx`](../../src/apps/crm/settings/ProgrammesSettings.tsx), [`src/apps/crm/settings/AccessSettings.tsx`](../../src/apps/crm/settings/AccessSettings.tsx), [`src/apps/crm/components/RecordPanel.tsx`](../../src/apps/crm/components/RecordPanel.tsx), [`src/apps/crm/Home.tsx`](../../src/apps/crm/Home.tsx), [`src/apps/crm/CrmShell.tsx`](../../src/apps/crm/CrmShell.tsx)):**
     - Delivered the 14-programme 5-area registry, Applications grid + Website enquiries tab with `"Visitor's words"` read-only tab, Workspace `/api/approvals` integration tab, Convert modal, Programme Profile settings, inline scoped grants in Capabilities settings, live Relationship Timeline, compact `"More"` bottom sheet, and Home My Work v1.
   - **S2 Verification:** `npm run typecheck`, `npm run build`, and targeted Vitest (`tests/crm-rules.test.ts`, `tests/crm-contract.test.ts`, `tests/crm-grants-d1.test.ts`, `tests/crm-p1-programmes-d1.test.ts`, `tests/crm-isolation.test.ts`, `tests/crm-routes.test.ts`, `tests/crm-client-contract.test.ts`) **7/7 files, 34/34 tests passed**. Commit `c66740e`.
10. **P1 Milestone 3 (S3) — Activities, My Work Dashboard & Workspace Automation Recipes (25 Nov 2026, branch `crm/p1-core`):**
   - **Automation Recipes ([`shared/crm/automationRecipes.ts`](../../shared/crm/automationRecipes.ts)):**
     - Added pure `AutomationConfig` recipe builders (*Website enquiry -> follow-up activity*, *Application stage -> approval request*, *Follow-up due reminder*) validated against `shared/automations.ts` with zero second engine.
   - **Frontend ([`src/apps/crm/components/QuickActivityComposer.tsx`](../../src/apps/crm/components/QuickActivityComposer.tsx), [`src/apps/crm/activities/ActivitiesView.tsx`](../../src/apps/crm/activities/ActivitiesView.tsx), [`src/apps/crm/settings/AutomationsSettings.tsx`](../../src/apps/crm/settings/AutomationsSettings.tsx), [`src/apps/crm/Home.tsx`](../../src/apps/crm/Home.tsx), [`src/apps/crm/components/RecordPanel.tsx`](../../src/apps/crm/components/RecordPanel.tsx)):**
     - Delivered accessible activity/follow-up logging (ISO datetime in `p_f_when` + `p_f_due`), Overdue/Today/Upcoming/Done views with `"Mark done"` and `"+1 day"` reschedule, inline `+ Follow-up` dialog in `RecordPanel`, Automation recipes management tab, and full Home My Work dashboard with offline partial notice.
   - **S3 Verification:** `npm run typecheck`, `npm run build`, and targeted Vitest (`tests/crm-p1-activities-d1.test.ts`, `tests/crm-p1-programmes-d1.test.ts`, `tests/crm-isolation.test.ts`, `tests/crm-routes.test.ts`) **4/4 files, 9/9 tests passed**. Commit `14789fa`.
11. **P1 Milestone 4 (S4) — Conversations Core, Verified Facts, Grounded AI Drafts & MCP (25 Nov 2026, branch `crm/p1-core`):**
   - **Shared & AI Capabilities ([`shared/crm/conversations.ts`](../../shared/crm/conversations.ts), [`shared/aiCapabilities.ts`](../../shared/aiCapabilities.ts)):**
     - Added messaging window (`24h` for WhatsApp/IG/FB), fact staleness (`reviewBy < now`), deterministic verified-fact-only draft composition (`composeGroundedAiDraft`), and 8 `'crm'` capability entries (5 read, 3 proposal, zero side-effect CRM tools).
   - **Backend & MCP ([`worker/crm/adapters/simulated.ts`](../../worker/crm/adapters/simulated.ts), [`worker/crm/facts.ts`](../../worker/crm/facts.ts), [`worker/crm/conversations.ts`](../../worker/crm/conversations.ts), [`worker/crm/mcp.ts`](../../worker/crm/mcp.ts), [`worker/crm/commands.ts`](../../worker/crm/commands.ts), [`worker/crm/index.ts`](../../worker/crm/index.ts), [`worker/mcp.ts`](../../worker/mcp.ts)):**
     - Implemented simulated local-test-only delivery/inbound adapter, fact lifecycle (`fact.propose`/`verify`/`retire`, `GET /read/facts`), full conversation & message commands (human-only `via === 'ui'` send/retry, consent withdrawal + window checks, internal note outbox separation, grounded draft generation), `/read/conversations` + `/read/conversation/:id`, and `registerCrmMcpTools` enforcing `ReadGate` observation and runtime `CRM_ENABLED` + `crm.access` checks.
   - **Frontend & Harness ([`src/apps/crm/conversations/ConversationsView.tsx`](../../src/apps/crm/conversations/ConversationsView.tsx), [`src/apps/crm/settings/FactsSettings.tsx`](../../src/apps/crm/settings/FactsSettings.tsx), [`scripts/qa-ux.mjs`](../../scripts/qa-ux.mjs)):**
     - Delivered responsive 3-pane desktop / 2-pane tablet / dedicated `.vv-fit` mobile Conversations inbox + composer (`Reply` vs `Internal note`, AI draft citations, consent/window locks, local-test `Simulate`), Verified Facts settings, and `--crm` `WORKSPACE_ENV: 'local-test'` UX-lab wiring without touching `wrangler.jsonc`.
   - **S4 Verification:** `npm run typecheck`, `npm run build`, and targeted Vitest (`tests/crm-p1-conversations-d1.test.ts`, `tests/crm-p1-mcp-d1.test.ts`, `tests/assistant-registry.test.ts`, `tests/crm-isolation.test.ts`, `tests/crm-routes.test.ts`) **5/5 files, 14/14 tests passed**. Commit `ce330a7`.
12. **P1 Milestone 5 (S9) — Pipelines, Project Handoff & Read-Only Patrons (25 Nov 2026, branch `crm/p1-core`):**
   - **Shared & Backend ([`shared/crm/pipelines.ts`](../../shared/crm/pipelines.ts), [`worker/crm/pipelines.ts`](../../worker/crm/pipelines.ts), [`worker/crm/index.ts`](../../worker/crm/index.ts)):**
     - Defined the 5 canonical TCG pipelines (`partnership`, `consulting`, `production`, `funding`, `supply`) matching `db_opportunities.f_pipeline`.
     - Implemented idempotent `opportunity.handoff_project` (`_crm_project_id` projection + `f_projects`/`f_program`/`f_people`/`f_orgs`/`related` links) and strictly read-only `GET /api/crm/read/patrons` backed by `ReadGate` over `board-website-inbox` without exposing any patron write commands.
   - **Frontend ([`src/apps/crm/pipeline/PipelineView.tsx`](../../src/apps/crm/pipeline/PipelineView.tsx), [`src/apps/crm/members/PatronsView.tsx`](../../src/apps/crm/members/PatronsView.tsx), [`src/apps/crm/api.ts`](../../src/apps/crm/api.ts), [`src/apps/crm/routes.tsx`](../../src/apps/crm/routes.tsx), [`src/apps/crm/CrmShell.tsx`](../../src/apps/crm/CrmShell.tsx)):**
     - Delivered responsive 5-pipeline Grid + Board views with accessible `>=44px` stage `<select>` controls (zero drag-only lock-in), Opportunity detail handoff action & Workspace link, and the strictly read-only Patrons mirror with search and tier filter.
   - **S9 Verification:** `npm run typecheck`, `npm run build`, and targeted Vitest (`tests/crm-p1-pipelines-patrons-d1.test.ts`, `tests/crm-isolation.test.ts`, `tests/crm-routes.test.ts`) **3/3 files, 7/7 tests passed**. Commit `e5d854a`.
13. **P1 Milestone 6 — Commons Demo Expansion, Cross-Platform UX Matrix & Full P1 Package Certification (25–26 Nov 2026, branch `crm/p1-core`):**
   - **Commons Fixture & Walkthrough (`scripts/crm-demo/data.mjs`, `scripts/crm-demo/preview.mjs`):**
     - Expanded Riverbank Commons into an integrated realistic S1–S4 + S9 fixture (`5` accounts, `30` people including duplicate collisions, `8` organisations, `12` affiliations, `14` programmes, `3` verified facts, `5` activities, `6` opportunities across all `5` pipelines, `3` patrons, website enquiries, backfill/consent/WhatsApp+Call+note+grounded AI draft+handoff) producing **21** deterministic desktop/tablet/mobile light/dark screenshots under `.artifacts/crm-demo/`.
   - **P1 Cross-Platform UX Lab Suite (`scripts/ux-lab/crm-workflows.spec.mjs`):**
     - Added deterministic S1–S4 + S9 browser workflows asserting Protocol 3 sync push, pack installation alongside pre-existing Website inbox, duplicate review & dismissal, relationship timeline, Overdue/Today/Done activities + My Work, simulated WhatsApp/Call conversations + grounded AI drafts, 5-pipeline views & `>=44px` stage selector controls, idempotent Project handoff, read-only Patrons view, 320px reflow, 200% text scaling, touch-target geometry, WCAG 2.2 AA axe checks, and P1 visual baselines (`crm-people.png`, `crm-conversations.png`, `crm-pipelines.png`, `crm-patrons.png`).
   - **Cross-Browser Accessibility, Layout & Projection Fixes:**
     - `worker/crm/pipelines.ts`: matched both `'patron'` and `'patrons'` families in `readPatrons()`.
     - `src/apps/crm/hooks/useCrmDatabases.ts`: required full core CRM pack databases in `needsPackInstall` even when `board-website-people` already exists.
     - `src/apps/crm/CrmShell.tsx`, `CrmGrid.tsx`, `RecordPanel.tsx`, `ConversationsView.tsx`, `PeopleView.tsx`, `OrganisationsView.tsx`, `PipelineView.tsx`, `ApplicationsView.tsx`: fixed React Rules of Hooks order on cold `/crm/*` reload, added desktop `relative overflow-hidden` scroll containment, focusable `role="region"` scroll containers, checkbox/sticky column target spacing (`!left-10`, `tabIndex={-1}` gridcells), contrast-safe note/endpoint tokens, removed mismatched `aria-label`, and immediate post-command `syncNow()`.
     - `src/apps/crm/crm.css`: added `-webkit-appearance: none; appearance: none;` + light/dark chevrons on `.crm-select` so Safari/WebKit honors `min-height: 2.75rem` (`44px`) on `<select>` controls.
     - `src/core/views/DatabasePage.tsx` & `scripts/ux-lab/playwright.config.mjs`: extended the N4 `max-md:shrink-0` fix on `ViewTabMenu` and `+ View` wrappers to `shrink-0` across all viewports (eliminating pre-existing 820px tablet `target-size` overlap on `ux-records`) and recorded a separate 6-tablet baseline set under `.artifacts/ux-lab/baselines-tablet-a11y-fix/`.
     - `src/core/settings.tsx`: fixed pre-existing WCAG 2.2 AA `color-contrast` violations caught by Firefox on Settings AI connectors (`Revoke` button `text-red-700 dark:text-red-300`, password status error fallback, and `Connected apps` `legend`/`p` `text-neutral-600 dark:text-neutral-400`).
14. **P2 Milestone 1 — Bounded P1 Hardening (`28b3971`, branch `crm/p2-integrity`):**
    - Enforced ReadGate + atomic SC-2.2 authority rechecks across `readCrmHome()`, conversation, application, pipeline, and patron reads (`worker/crm/applications.ts`, `worker/crm/conversations.ts`, `worker/crm/pipelines.ts`, `worker/crm/read.ts`).
    - Reconciled AI draft & fact proposal MCP handlers with frozen `ai_previews`, request-ID deduplication, connector revocation fences, and human-only approval/send boundaries (`worker/crm/mcp.ts`, `worker/crm/facts.ts`).
    - Hardened messaging delivery fences & `via` preservation and enforced My Work owner isolation, per-programme `responseTargetDays`, and `workspace_settings.time_zone` boundaries (`tests/crm-p2-hardening-d1.test.ts`).
15. **P2 Milestone 2 — S10 Merge Contract, Migration 0047 & Pure Helpers (`647926b`, branch `crm/p2-integrity`):**
    - Authored [`contracts/crm-p2-v1.md`](contracts/crm-p2-v1.md) and [`migrations/0047_crm_merge.sql`](../../migrations/0047_crm_merge.sql) (`crm_person_aliases`, append-only `crm_merges` & `crm_merge_unmerges` with UPDATE/DELETE triggers); registered SHA-256 across release/certification manifests (`47` migrations).
    - Added `CRM_PROJECTION.mergedInto` ([`shared/crm/projection.ts`](../../shared/crm/projection.ts)) and pure field/endpoint/consent/budget helpers in [`shared/crm/merge.ts`](../../shared/crm/merge.ts) with unit tests in [`tests/crm-p2-merge.test.ts`](../../tests/crm-p2-merge.test.ts).
16. **P2 Milestone 3 — S10 Backend Merge, Reversible Unmerge & Alias Resolution (`037c876`, branch `crm/p2-integrity`):**
    - Implemented [`worker/crm/merge.ts`](../../worker/crm/merge.ts) (`readMergePreview`, `readMergeHistory`, atomic `person.merge` under 45-call D1 budget & `MAX_EXPECTED_ENTRIES = 100`, revision-aware conflict-detecting `person.unmerge` for `admin|owner`), mounted under [`worker/crm/index.ts`](../../worker/crm/index.ts).
    - Wired canonical alias resolution & non-broadening consent rules across `worker/crm/{identity,conversations,applications,pipelines,mcp}.ts`, `worker/websiteIngest.ts`, and `worker/forms.ts`, verified in [`tests/crm-p2-merge-d1.test.ts`](../../tests/crm-p2-merge-d1.test.ts).
17. **P2 Milestone 4 — S10 Responsive Merge UI, Demo Walkthrough & Timestamp Fix (`db5482d`, `494fdb8`, branch `crm/p2-integrity`):**
    - Added S10 client reads/commands & conflict extractors in [`src/apps/crm/api.ts`](../../src/apps/crm/api.ts) and [`tests/crm-p2-merge-client.test.ts`](../../tests/crm-p2-merge-client.test.ts).
    - Delivered accessible responsive [`MergeCompareDialog.tsx`](../../src/apps/crm/people/MergeCompareDialog.tsx), [`MergeHistoryTab.tsx`](../../src/apps/crm/people/MergeHistoryTab.tsx), [`PeopleView.tsx`](../../src/apps/crm/people/PeopleView.tsx) URL-persisted tabs & identity-scoped confirmation banner across Protocol 3 revalidation remounts, and archived/alias handling in [`RecordPanel.tsx`](../../src/apps/crm/components/RecordPanel.tsx).
    - Expanded `scripts/crm-demo/` (`data.mjs`, `preview.mjs` Part D) and `scripts/ux-lab/crm-workflows.spec.mjs` (`P2 S10`), and moved variable `<time className="crm-tabular block">` to its own line in `MergeHistoryTab.tsx` (`494fdb8`) for screenshot mask stability.
18. **P3 Milestone 0 — Risk-Based Testing & Certification Cadence (`a7d0700`, branch `crm/p3-communications`):**
    - Recorded **A-28** in [`01-DECISIONS.md`](01-DECISIONS.md) and [`11-ROADMAP.md`](11-ROADMAP.md): targeted high-signal unit/integration/security/responsive checks per intermediate package while scheduling full 18-project CRM + Workspace cross-browser certification matrices for **P4** and **P6** (preserving deferred P2 certification requirements explicitly).
19. **P3 Milestone 1 — Closed All 6 P2 Independent Review Findings (`352b9c1`, branch `crm/p3-communications`):**
    - Required valid reviewed `expectedRevisions` on both `person.merge` and `person.unmerge` (`shared/crm/merge.ts`, `worker/crm/merge.ts`, `src/apps/crm/people/MergeHistoryTab.tsx`).
    - Fenced the complete affected reference set (records, links, endpoints, consents, conversations, duplicate decisions, `form_people_keys`) against concurrent additions and mutations.
    - Evaluated effective consent using the latest append-only row per `(person, channel, scope)` independently of paginated history limits, with strict SQL/application-level parity.
    - Refused or safely redirected consequential writes against merged/archived person aliases across `worker/crm/{identity,conversations,applications,pipelines}.ts`.
    - Detected post-merge operational-state changes (endpoints, duplicate decisions, `form_people_keys`, consents) before allowing `person.unmerge`.
    - Re-verified current linked-record `ReadGate` authority on `person.merge` and `person.unmerge` idempotent replays (`tests/crm-p2-merge-d1.test.ts`, `tests/crm-p2-merge-client.test.ts`).
20. **P3 Milestone 2 — P3 Contract, Migration `0048` & Shared Channel Schemas (`7b8e12a`, branch `crm/p3-communications`):**
    - Verified official Zoho Mail REST API, Meta WhatsApp Cloud API, and Meta Instagram/Facebook Messaging API documentation; authored [`contracts/crm-p3-v1.md`](contracts/crm-p3-v1.md).
    - Added [`migrations/0048_crm_communications.sql`](../../migrations/0048_crm_communications.sql) (SHA-256 `98c1cc35502e08aabf8539326dba9c9f54cbfbfaa31621c2f7bea05023963611`; safe FK-preserving `crm_messages` rebuild adding `review_required` + RFC 5322 threading columns, channel polling leases/cursors, template lifecycle columns, and outbox review/backoff columns) and registered all 48 migrations across certification manifests (`scripts/certification/migrations.json`, `scripts/release-rehearsal.mjs`, `scripts/release-preflight.mjs`).
    - Built pure channel, RFC 5322 header threading, messaging-window, opt-out keyword, and DTO/command schemas in [`shared/crm/channels.ts`](../../shared/crm/channels.ts) (`tests/crm-p3-channels.test.ts`).
21. **P3 Milestone 3 — S5 Zoho Mail Adapter, Durable Polling & Outbox Review (`5c5e99b`, branch `crm/p3-communications`):**
    - Implemented [`worker/crm/adapters/types.ts`](../../worker/crm/adapters/types.ts), [`worker/crm/adapters/zohoMail.ts`](../../worker/crm/adapters/zohoMail.ts) (disabled by default, regional `mail.zoho.*`/`accounts.zoho.*` host allowlist, Worker-secret binding check, `askReceipt: 'no'` honoring P-16, header-only RFC 5322 threading), and [`worker/crm/channels.ts`](../../worker/crm/channels.ts) (durable cursor/lease polling, exponential outbox backoff `30s -> 2m -> 10m`, ambiguous outcome -> `review_required` with human resolution `message.resolve_review`).
    - Hooked `runCrmScheduledSweep()` inside phase 10 of [`worker/reminders.ts`](../../worker/reminders.ts) strictly gated by `isCrmEnabled(env) && hasD1Budget(env.DB, 10)`, preserving `SCHEDULED_PHASE_COUNT = 10` and zero DB work when CRM is disabled (`tests/crm-p3-zoho-d1.test.ts`).
22. **P3 Milestone 4 — S11 WhatsApp Cloud & S12 Instagram/Facebook Adapters + Signed Webhooks (`5ff872f`, branch `crm/p3-communications`):**
    - Implemented [`worker/crm/adapters/whatsappCloud.ts`](../../worker/crm/adapters/whatsappCloud.ts) (24h window + approved template enforcement, `wamid` idempotency, monotonic `sent < delivered < read` receipts, `STOP`/opt-out -> withdrawn consent + cancel queued non-transactional outbox), [`worker/crm/adapters/metaMessaging.ts`](../../worker/crm/adapters/metaMessaging.ts) (`igsid:`/`psid:` scoped identities, 24h standard + 7-day human-only `HUMAN_AGENT` tag when approved, `is_echo` skip), and [`worker/crm/webhooks.ts`](../../worker/crm/webhooks.ts) (GET handshake + constant-time raw-body HMAC-SHA256 `X-Hub-Signature-256`, mounted at `/api/crm/webhooks/:provider` in `worker/index.ts`, `tests/crm-p3-meta-d1.test.ts`).
23. **P3 Milestone 5 — Responsive Channels Settings UI, Inbox Controls & Deterministic Verification (`0ec5a01`, `2484fd4`, branch `crm/p3-communications`):**
    - Built [`src/apps/crm/settings/ChannelsSettings.tsx`](../../src/apps/crm/settings/ChannelsSettings.tsx) (`/crm/settings/channels`: Channel accounts, Templates lifecycle, Delivery & human review queue) and enhanced [`src/apps/crm/conversations/ConversationsView.tsx`](../../src/apps/crm/conversations/ConversationsView.tsx) (closed-window WhatsApp template picker, 7-day `HUMAN_AGENT` indicator, RFC 5322 threading indicator, inline human review actions, `tests/crm-p3-channels-client.test.ts`).
    - Added deterministic local verification script [`scripts/verify-p3-communications.mjs`](../../scripts/verify-p3-communications.mjs), extended [`scripts/crm-demo/preview.mjs`](../../scripts/crm-demo/preview.mjs) (Part E) with desktop/mobile Channels checks, updated `release-preflight` to 48 migrations, and documented controlled parallel local execution & optional manual-only `workflow_dispatch` CI certification in [`contracts/crm-p3-v1.md`](contracts/crm-p3-v1.md) section 10.

---

## Baseline & Screenshot Provenance

| Artifact Set | Source & Method | Coverage | Status |
|---|---|---|---|
| **Original Workspace baselines** (`.artifacts/ux-lab/baselines/`) | Unmodified isolated checkout of `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`fingerprint: 87796aa3f5f95da3ee1aa6f37004690d58da32cea00e0d51373e32429101b1ec`, recorded `2026-11-25T01:21:51.352Z`) | 6 desktop projects verified unchanged (original 12 desktop/tablet baselines preserved untouched) | **Desktop 6/6 pass** `maxDiffPixels: 0` |
| **Corrected compact Workspace baselines** (`.artifacts/ux-lab/baselines-compact-a11y-fix/`) | Isolated detached checkout of `38c388a` (`baseFingerprint: 87796aa3...`) + ONLY `src/core/views/DatabasePage.tsx` compact patch (`patchSha256: 7a02a0ae2a79104a8116fa265b0eb35f5e85c0de0c9818db007333ee45638379`, recorded `2026-11-25T06:44:09.353Z`) | 6 compact `390×844` projects (`website-inbox.png`, `compact-a11y-fix.patch`, `provenance.json`) | **6/6 pass** `maxDiffPixels: 0` + WCAG 2.2 AA axe |
| **Corrected tablet Workspace baselines** (`.artifacts/ux-lab/baselines-tablet-a11y-fix/`) | Isolated detached checkout of `38c388a` (`baseFingerprint: 87796aa3...`) + ONLY `src/core/views/DatabasePage.tsx` `shrink-0` wrapper patch (`patchSha256: 3c5edf178569c004378dd39c8b88a79b0df7270675485cfb202b9cc5df88261b`, recorded `2026-11-25T12:43:46.939Z`) | 6 tablet `820×1180` projects (`website-inbox.png`, `tablet-a11y-fix.patch`, `provenance.json`) | **6/6 pass** `maxDiffPixels: 0` + WCAG 2.2 AA axe |
| **CRM explicit visual baselines** (`.artifacts/ux-lab/crm-baselines/`) | Recorded via `npm run qa:ux -- --crm --record --skip-build` on `494fdb8` (`2026-11-26T15:08:58.285Z`, fingerprint `4da6f6b0b6975684eb2fd53415a549883b97356309ab0c9413f5c1146fd9edb4`) | All 18 projects × 9 PNGs = **162 visual references** (`crm-home.png`, `crm-settings-capabilities.png`, `crm-access-denied.png`, `crm-people.png`, `crm-conversations.png`, `crm-pipelines.png`, `crm-patrons.png`, `crm-merge-preview.png`, `crm-merge-history.png`) + `provenance.json` | **18/18 baseline recording passed (`108/108` tests)**; full non-record verification paused after `chromium-compact-light` (`6/6`) and `chromium-compact-dark` (`6/6`) |
| **Commons demo screenshots** (`.artifacts/crm-demo/`) | Generated by `npm run demo:crm -- --check` on `2484fd4` (`CRM_ENABLED=true`, `WORKSPACE_ENV=local-test`, fingerprint `6c2c328dc13a2c1a4dad30fab33a84ba33c8d4e7a64e57d9da84568ecb887cba`) | **29** light & dark desktop, tablet, and compact mobile walkthrough PNGs (incl. `channels-desktop-light.png`, `channels-desktop-dark.png`, `channels-mobile-light.png`) + `ready.json` (`p2MergeVerified: true`, `p3CommunicationsVerified: true`) | **Passed on `2484fd4`** |

---

## P3 Verification & Deferred Certification Checkpoint (27 Nov 2026, `crm/p3-communications`)

### Verified on Current Source (`2484fd4`, fingerprint `6c2c328dc13a2c1a4dad30fab33a84ba33c8d4e7a64e57d9da84568ecb887cba`)

- **All CRM + P2/P3-Adjacent Workspace Vitest Suites:** **32/32 files, 187/187 tests passed** (`0` failed, `0` skipped, `139.74s`):
  - All 26 `tests/crm-*.test.ts` suites (S0, P1, P2 hardening & merge + all 6 P2 review closures, P3 `crm-p3-channels` (4), `crm-p3-zoho-d1` (3), `crm-p3-meta-d1` (3), `crm-p3-channels-client` (2)).
  - Adjacent Workspace suites: `tests/phase4-reminders-d1.test.ts`, `tests/phase4-forms-d1.test.ts`, `tests/website-ingest-d1.test.ts`, `tests/admin-owner-protection-d1.test.ts`, `tests/assistant-registry.test.ts`, `tests/tcg-pack.test.ts`.
  - Plus `tests/phase5-search-d1.test.ts` verified **9/9 passed** (`74.19s`) in isolation (full sequential 245-file `npm test` under `maxWorkers: 1` exceeded a 600s wait window and was replaced under A-28 by the complete 32-suite targeted regression run).
- **Deterministic P3 Gate (`node scripts/verify-p3-communications.mjs`):** Passed all steps (`typecheck`, `build`, `14` core P2/P3 Vitest suites `42/42`, `tcg-pack` validation `20` databases / `78` views / `38` pages, certification selftests).
- **Certification Selftests & Release Preflight:**
  - `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`: **153/153 passed** (`0` failed, `0` skipped).
  - `npm run release:preflight`: **17 PASS / 0 FAIL** (including `48 immutable migration hashes`, `fifteen-minute Cron`, `secret values absent from config`, `built package matches deployment contract`).
  - `npm run db:migrate:local`: `0048_crm_communications.sql` applied cleanly (`48` total migrations).
- **Demos & Targeted Responsive Browser Verification:**
  - `npm run demo:studio -- --check`: **passed**.
  - `npm run demo:crm -- --check`: **passed** (**29** screenshots across Chromium `1440×900` light/dark, tablet `820×1180`, and WebKit mobile `390×844` light/dark; verified Parts A–E including P3 `/crm/settings/channels` Channels/Templates/Delivery tabs and zero horizontal overflow on desktop and mobile WebKit).

### Deferred / Outstanding Certification & External Gates (Per A-28)

1. **Full 18-project CRM UX visual regression matrix (`npm run qa:ux -- --crm`)** — deferred from P2 (`494fdb8`) and P3 (`2484fd4`) to the **P4** and **P6** certification milestones under **A-28** (including new P3 Channels/Templates/Delivery visual baselines when scheduled).
2. **Full 18-project Workspace CRM-off UX regression matrix (`npm run qa:ux`)** — deferred from P2 and P3 to **P4** and **P6** under **A-28** (preserved baselines untouched under `.artifacts/ux-lab/baselines/`, `baselines-compact-a11y-fix/`, and `baselines-tablet-a11y-fix/`).
3. **Full 245-file sequential `npm test` sweep** — deferred to P4 certification (all 32 CRM + adjacent Workspace suites + `phase5-search-d1` passed `196/196` on `2484fd4`).
4. **Real provider verification (NOT RUN — simulated/mocked transport only):**
   - Simulated/mocked tests verify internal adapter contracts, state transitions, signature checks, window/template/opt-out rules, backoff, and human review flows only — they do **not** establish real Zoho Mail, Meta WhatsApp Cloud, or Meta Instagram/Facebook live API compatibility.
   - Real provider activation remains blocked on unresolved owner/provider decisions **`O-04`** (WhatsApp number strategy & WABA/Phone Number ID), **`O-20`** (Zoho data centre, plan/API access, and Sent sync), **`O-21`** (Zoho polling cadence), **`O-17`** (retention/erasure policy), **`P-16`** (no open/click tracking confirmation), and **`P-20`** ("Conversations" naming & `Asia/Kolkata` default), plus Meta `HUMAN_AGENT` approval and Worker secret provisioning.
5. **External `NOT RUN` gates (unchanged):** real physical hardware, native 400% OS zoom, human assistive-technology assessment, and remote D1 migrations / production activation / deploy.

---

## P2 Verification & Deferred Certification Checkpoint (Historical Reference, `crm/p2-integrity` @ `494fdb8`)

### Verified on Current Source (`494fdb8`, fingerprint `4da6f6b0b6975684eb2fd53415a549883b97356309ab0c9413f5c1146fd9edb4`)

- **Targeted P2 Core & Hardening Vitest Suites:** **9/9 files, 80/80 tests passed** (`0` failed, `0` skipped):
  - `tests/website-ingest-d1.test.ts` (34)
  - `tests/phase4-forms-d1.test.ts` (16)
  - `tests/crm-p2-hardening-d1.test.ts` (4 — ReadGate, SC-2.2 races, frozen AI previews, messaging fences, My Work/timezone)
  - `tests/crm-p2-merge-d1.test.ts` (4 — preview, atomic merge, clean unmerge, conflict refusal, budget/race/revocation, alias resolution & MCP refusal)
  - `tests/crm-client-contract.test.ts` (10)
  - `tests/crm-isolation.test.ts` (3)
  - `tests/crm-p2-merge-client.test.ts` (3)
  - `tests/crm-p2-merge.test.ts` (4)
  - `tests/crm-routes.test.ts` (2)
- **Typecheck & Build:** `npm run typecheck` (0 errors) and `npm run build` (Worker + client + classic-script `sw.js`) passed cleanly on `494fdb8`.
- **18-Project CRM Baseline Recording (`npm run qa:ux -- --crm --record --skip-build`):** Run `.artifacts/ux-lab/2026-11-26T14-47-30.362Z` passed **18/18 projects (`108/108` tests)** across Chromium, Firefox, WebKit × compact/tablet/desktop × light/dark, exercising S0, P1, and P2 S10 merge/unmerge/conflict/320px/accessibility checks and writing **162** CRM baselines.
- **Partial Non-Record CRM Verification (`npm run qa:ux -- --crm --skip-build`):** Run `.artifacts/ux-lab/2026-11-26T15-10-08.564Z` passed `chromium-compact-light` (**6/6**) and `chromium-compact-dark` (**6/6**) at `maxDiffPixels: 0` before being intentionally paused mid-run (`chromium-tablet-light`) at owner direction to conserve model quota.

### Verified on Immediately Prior Commit (`db5482d`, prior to the 10-line `<time>` JSX wrap in `MergeHistoryTab.tsx` `494fdb8`)

- **Full Vitest suite (`npm test`):** **241/241 test files, 2,331/2,331 tests passed** (`0` failures, `0` skipped, `0` A-24 flakes).
- **Local D1 Migrations & Pack:** `npm run db:migrate:local` applied `0047_crm_merge.sql` cleanly (`47` total migrations); `node scripts/_validate-tcg-pack.mjs` passed (`20` databases, `78` views, `38` pages, `1` link).
- **Certification Scripts (`node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`):** **153/153 passed** (`0` failed, `0` skipped).
- **Demos:** `npm run demo:studio -- --check` (`Seeded 36 records and 19 views`, `.artifacts/studio-demo/run-IutvIK`) and `npm run demo:crm -- --check` (`p2MergeVerified: true`, **26** screenshots in `.artifacts/crm-demo/`) passed.

### Deferred / Outstanding Certification Checks (NOT RUN / PAUSED on `494fdb8`)

1. **Full 18-project non-record CRM visual regression matrix** (`npm run qa:ux -- --crm --skip-build`) against `494fdb8` baselines (paused cleanly during `chromium-tablet-light`; `chromium-compact-light` and `chromium-compact-dark` passed 6/6 each).
2. **Full 18-project Workspace CRM-off UX regression matrix** (`npm run qa:ux -- --skip-build`) on `494fdb8` against the untouched preserved baselines under `.artifacts/ux-lab/baselines/`, `baselines-compact-a11y-fix/`, and `baselines-tablet-a11y-fix/`.
3. **Post-`494fdb8` re-run** of full 241-file `npm test`, `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`, `node scripts/_validate-tcg-pack.mjs`, and Studio/CRM demos (all passed on `db5482d` immediately before `494fdb8`).
4. **External `NOT RUN` gates (unchanged):** real physical hardware, native 400% OS zoom, human assistive-technology assessment, and remote D1 migrations / production activation / deploy.

---

## P1 Integrated Certification Evidence (Historical Reference, `crm/p1-core` @ `ef39f6c`)

Checks matching the final code fingerprint (`79480143868470589cfd993dda52b5c26a981588d1bf06f16a861fca46f37b74`):

- **Typecheck & Build:** `npm run typecheck` (0 errors) and `npm run build` passed cleanly (Worker + client + classic-script `sw.js`).
- **Local D1 Migrations, Pack & Certification Scripts:**
  - `npm run db:migrate:local` succeeded (`No migrations to apply!`, 46 migrations applied cleanly).
  - `node scripts/_validate-tcg-pack.mjs`: passed (`TCG Operating Pack`: `20` databases (`209` fields, `86` paired + `12` one-way relation fields), `78` views, `38` pages (`17` templates), `1` link, `103.0 KB`).
  - `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`: **153/153 tests passed** (`0` failed, `0` skipped).
- **Demos:**
  - `npm run demo:studio -- --check`: passed (`Seeded 36 records and 19 views`, `.artifacts/studio-demo/run-tOzJhL`).
  - `npm run demo:crm -- --check`: passed (`5` accounts, `30` people, `8` organisations, `14` programmes, `6` opportunities, `3` patrons, `3` facts; `21` screenshots + `ready.json` in `.artifacts/crm-demo/`).
- **Full 18-Project CRM UX Matrix (`npm run qa:ux -- --crm --skip-build`):**
  - Run `.artifacts/ux-lab/2026-11-25T16-39-47.071Z`: **18/18 projects passed (`exitCode: 0`, `projectsComplete: true`, `90/90` expected, `0` unexpected, `0` skipped, `0` flaky)** across all 126 visual references (`maxDiffPixels: 0`), verifying S0 & P1 workflows, keyboard navigation, WCAG 2.2 AA axe checks, `320px` reflow, `200%` text scaling, and `>=44px` touch targets across Chromium, Firefox, and WebKit × compact, tablet, and desktop × light and dark.
- **Full 18-Project Workspace CRM-off UX Matrix (`npm run qa:ux -- --skip-build`):**
  - Run `.artifacts/ux-lab/2026-11-25T16-58-36.690Z`: **18/18 projects passed (`exitCode: 0`, `projectsComplete: true`, `coverage.complete: true`, `1,944/1,944` expected, `0` unexpected, `0` skipped, `0` flaky)** against untouched desktop baselines (`.artifacts/ux-lab/baselines/`) and isolated corrected compact/tablet baselines.

Prior full Vitest suite run (`npm test`, immediately prior to the final CSS/JSX/Playwright-config accessibility edits in `DatabasePage.tsx`, `crm.css`, `settings.tsx`, and `playwright.config.mjs` — none of which are imported by `tests/`):
- **237/237 test files, 2,316/2,316 tests passed** (`0` failures, `0` skipped; zero A-24 `SI-01` flakes).

---

## Backend-First S0 Execution Plan Status

| Stage | Scope | Status / Gate |
|---|---|---|
| **Stage 0** | ChatGPT reviews & freezes `crm-s0-v2.md`; Paul authorises Stage 1–2 implementation | **Complete (Checkpoint 1 @ `8aa6f53`)** |
| **Stage 1** | `shared/crm/capabilities.ts` -> `projection.ts` -> `contracts.ts` + `tests/crm-contract.test.ts` & `typecheck` | **Complete (4/4 passing)** |
| **Stage 2** | `migrations/0045_crm_foundation.sql`, `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/crm/*`, certification scripts, 8 backend test suites | **Complete (Checkpoint 2 @ `98938ec`)** |
| **Stage 3** | Original `38c388a` baseline, `src/routes.tsx`, `AppSwitcher.tsx`, `crmStatus.ts`, `CrmShell.tsx`, `Home.tsx`, `AccessSettings.tsx`, `crm.css`, `scripts/crm-demo/*`, `scripts/ux-lab/crm-shell.spec.mjs`, frontend unit tests | **Complete (`e9c0102`)** |
| **Stage 4 (N4)** | Targeted N4 corrections + S0 certification (`70b8bb1`) | **Complete (`70b8bb1`; S0 compact Workspace blocker closed in P1 Milestone 0 `566615e` and full 18-project Workspace certification passed `1,944/1,944` at P1 Milestone 6)** |

---

## Verification Evidence (25 Nov 2026, `crm/s0-frontend` Historical Reference)

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
- Historical N4 `typecheck`, `build`, demos, and 18-project CRM checks preserved in git history (`70b8bb1`).

---

## Blockers & Open Items

1. **Workspace cross-platform UX defects (`DatabasePage.tsx`, `settings.tsx`) — RESOLVED & CERTIFIED (`18/18`, `1,944/1,944`):**
   - Closed compact Database scroll clipping (`566615e`), tablet `ViewTabMenu`/`+ View` `shrink-0` target-size overlap (`DatabasePage.tsx` + `baselines-tablet-a11y-fix/`), and Settings AI connectors WCAG AA contrast (`settings.tsx`), achieving `18/18` project passes (`1,944/1,944` tests) across Chromium, Firefox, and WebKit × light and dark × compact, tablet, and desktop.
2. **Harness transient note:** Earlier during two N4 multi-project `qa:ux` starts, Wrangler's local dev HTTPS server returned a transient HTTP 500 `Error: Network connection lost.` on `POST /api/approvals` during fixture seeding; not observed during P1 certification runs.
3. **NOT RUN (unavailable / out-of-scope external gates):**
   - Real physical iPhone, iPad, Android, and Windows hardware (Emulated WebKit is not real iOS Safari).
   - Native 400% OS/browser zoom.
   - Human assistive-technology assessment (VoiceOver, TalkBack, NVDA).
   - Remote D1 migrations, production `CRM_ENABLED` activation, or deployment.
4. **Later-slice / production blockers (unchanged, outside S0):**
   - Production owner verification on an owner-exported D1 copy before remote activation (`S0-PLAN.md` section 5.2).
   - Pre-existing **SI-01** test stabilisation and open policy/provider decisions **O-04–O-07, O-09–O-18, O-20–O-21**.
