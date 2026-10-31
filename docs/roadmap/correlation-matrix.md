# Correlation matrix

How every planned item connects to existing code, data, AI surfaces, tests and
other items. "Touches" lists the primary files; "verify" means confirm at
implementation.

## 1. Feature matrix

| ID | Feature | Touches (primary) | Data / migration | MCP / AI | Tests (new files) | Depends on | Owner |
|---|---|---|---|---|---|---|---|
| R1 | `today±N` resolution | `shared/dates.ts`, `shared/views.ts:200`, `shared/automations.ts`, `DatabasePage.tsx` FilterRow, automations editor | none | `add_view`/`update_view`/`query_records` validation | `dates`, `views`, `automations` tests | R0 | D1 |
| 7.0 | D1 gate regex | `scripts/certify-phase4.mjs:118` | none | — | harness self-test | — | — |
| 7.1 | `within` op, created-date, date control | `shared/views.ts`, `shared/dates.ts`, FilterRow, automations editor | none | view schemas, server instructions | `views`, browser | R1 | — |
| 7.2 | Workspace locale | new `worker/workspaceSettings.ts`, `shared/dates.ts`, `src/core/utils.ts:39`, `mcpReadTools.ts:78,84`, `aiDigest.ts:13`, `reminders.ts`, `automations.ts:696`, `notifications.ts`, `MetricBlock.tsx:30`, `shared/fields.ts`, `cells.tsx`, `FieldsEditor.tsx`, settings | **M1** `workspace_settings` | `workspace_overview` adds locale | `phase7-locale-d1` | 7.1 | D2 |
| 7.3 | Account disable | `worker/admin.ts`, settings Admin, people pickers | none (`users.disabled_at` exists; `access_audit` exists) | user lists include `disabled` | `phase7-disable-d1` | — | D3 |
| 7.4 | Pack upgrade | `shared/bundled.ts`, `templates/tcg-pack.json` (keys, version), template gallery UI | none (additive record keys `templateItemKey`, `templateVersion`) | `install_template` `mode:'upgrade'` (significant) | `bundled` tests, D1 parity | 7.2 | — |
| 8.0 | Resumable, sleep-aware certification | scripts/certify-phase4.mjs; scripts/certification/ | None; tooling only | No MCP/AI/data | Eligibility, pause/status/report harness tests; real post-D1 pause/resume demonstration | Phase 7 accepted and draft PR open | — |
| 8.1 | Attention queue | `shared/attention.ts`, `shared/attentionActions.ts`, `worker/attention.ts`, client cache/block/settings, template compiler/upgrade and Website defaults | none | **new R** `attention_queue`; action `triage_my_attention`; `update_board` accepts `attention` | `phase8-attention-*`, navigation helper, populated/offline/config/gated browser matrix | 7.1, 7.2, 7.4 | D6 |
| 8.2 | Daily command center | pack Home page, calendar block (multi-source; verify) | none | `dashboard_snapshot` | browser | 8.1, 8.9, 8.11, 7.4 | — |
| 8.3 | Website response desk | `shared/websiteStats.ts`, `src/modules/website/index.tsx`, `worker/website.ts` | none (built-ins; bands on board key) | `website_query` queue, `website_digest` bands, `propose_website_triage` assign/dates | Website UI gate, unit | 8.1, 9.0/9.5 (optional bulk) | D4, D5 |
| 8.4 | Project cockpit | new `shared/projectHealth.ts`, block `projecthealth`, pack Project Review | none | `dashboard_snapshot`, `operating_review_context`; action `summarize_project_health` | unit, parity | 8.1 | — |
| 8.5 | Funding and finance | new `shared/finance.ts`, block `budget`, pack Opportunities/Projects/Products | none | `dashboard_snapshot`; action `explain_budget` | unit, parity | 7.2 | — |
| 8.6 | Field evidence | new `shared/fieldSessions.ts`, `shared/measurements.ts`, blocks `fieldsessions`, `measurechart` | none | `dashboard_snapshot` | unit, a11y | 7.2 | — |
| 8.7 | Community and events | `shared/eventOps.ts`, configuration, authorized Worker/API, indexed local reads, eventops block, packv7 fields/views/attention; shared multi-select accessibility | none | `dashboard_snapshot` eventops summaries | `phase8-community-*`,144 affected browser cases, preserved MCP/pack/approval workflows; evidence/P8-community-533fe09.json | 8.1, 7.4 | — |
| 8.8 | Editorial desk | pack Media page | none | — | browser | 8.1, 7.4 | — |
| 8.9 | Reliability view | `src/core/sync/engine.ts` (sync times; verify), `QuarantineReview.tsx`, settings Local data, Home chip | Dexie `meta` keys | — | unit, offline browser, Android | — | — |
| 8.10 | Automation health | `worker/automations.ts` (new route), Automations module tab | optional **M2** `scheduler_runs` | **new R** `automation_health` (admin) | D1 | — | — |
| 8.12 | Ideas review and conversion handoff | pack Ideas page, `shared/conversion.ts` banner helper | none | `convert_idea_to_project` unchanged | browser, unit | 7.1, 7.4 | — |
| 8.13 | Meetings commitment review | new `shared/commitments.ts`, block `commitments`, pack Meetings pages | none | `dashboard_snapshot` | unit, parity, browser | 8.1, 7.4 | — |
| 8.14 | Forms operations view | `worker/forms.ts` (new routes), Forms module tab | none (`form_submissions` exists) | — | D1 | — | — |
| 8.11 | AI review desk | `src/core/AiWorkspace.tsx` | none | links to existing H tools | browser | — | — |
| 9.1 | CSV export | new `shared/csv.ts`, `src/core/records.ts` | none | — | unit, browser | 7.2 | — |
| 9.0 | `mutateMany` engine helper | `src/core/sync/engine.ts` | none | — | unit (fake-indexeddb) | — | — |
| 9.2 | CSV import | `shared/csv.ts`, new `src/core/views/ImportCsv.tsx`, `mutateMany` | Dexie `meta` journals | — | unit, D1 budget, browser | 9.0, 7.2 | — |
| 9.3 | Page export | `shared/markdown.ts`, global print CSS, `PublicView.tsx` | none | — | snapshots, print emulation | — | — |
| 9.4 | Resolved comments | `worker/mutationAccess.ts:162-183`, `src/modules/comments/index.tsx`, activity verbs, notification kind | none (comment fields) | **new W** `resolve_comments` | `phase9-comments-d1` + capability matrix | — | — |
| 9.5 | Bulk edit | table/list views, selection + action bar | Dexie `meta` journals | — | unit, browser, Android | 9.0 | — |
| 9.6 | Search dates | `worker/search.ts`, `worker/searchApi.ts`, ⌘K palette | **M3** `search_documents.updated_at` + index | `search` params | D1, browser | 7.1, 7.2 | — |
| 9.7 | Share expiry and rotation | `worker/public.ts:37-46`, `worker/shares.ts`, `Share.tsx` | **M4** `shares.expires_at`, `rotated_at` | `publish_page`, `share_moodboard` param | D1 (all 5 routes) | — | D10 |
| 10.1 | Verified email | `worker/auth.ts` or new `worker/email.ts`, settings Profile | **M5** `users.email`, `email_verified_at`, `email_verifications` | — | `phase10-email-d1` | 7.3 | D7 |
| 10.2 | Email channel | `worker/notifications.ts:91`, `worker/reminders.ts` (phase 10), `worker/auth.ts:94` prefs | **M6** `email_outbox` | — | `phase10-email-d1` | 10.1, 8.1 | D7 |
| 10.3 | Email digest | new `shared/digest.ts` | uses M6 | — | unit, D1 | 10.2, 8.1, 7.2 | — |
| 10.4 | Web push | new `worker/webpush.ts`, `src/sw.ts`, settings Notifications | **M7** `push_subscriptions` | — | RFC vectors, D1, browser | 10.2 | D8 |
| 11 | R2 storage | new `worker/fileStore.ts`; refactor `files.ts`, `forms.ts`, `public.ts`, `reminders.ts`, `remotefile.ts` | **M8** `files.storage`, `r2_key`, `sha256` | — | `phase11-storage-d1` | — | D9 |
| 12.1 | Rollups | `shared/fields.ts`, `shared/views.ts` (`ctx.computed`), new `shared/rollups.ts`, field editor | none | `query_records`/`get_record`/`dashboard_snapshot` compute | unit, parity | 7.2, 8.x justification | — |
| 12.2 | Formulas | new `shared/formula.ts` | none | same as 12.1 | fuzz, golden | 12.1 | — |
| 12.3 | Chart view | `shared/views.ts` `VIEW_TYPES`, new `shared/charts.ts`, view switch | none | `add_view`/`update_view`/`query_records` | `views`, `verify-mcp-phase1` | 7.1 | — |
| 12.4 | Automation branches | `shared/automations.ts`, automations editor | **M9** `automation_runs.branch` | — | unit, D1 | 7.1 | — |
| 12.5 | Moodboard export | `shared/canvasLayout.ts`, `svgSanitize`, moodboard menu | none | — | unit, browser | — | — |
| 13.1 | History diff | new `shared/textDiff.ts`, `src/core/History.tsx` | none | — | unit, browser | — | — |
| 13.2 | Conflict viewer | `src/core/sync/rebase.ts`, 8.9 panel | Dexie `meta` | — | unit, two-context browser | 8.9 | — |
| 13.3 | Group mentions | `shared/markdown.ts`, `core/mentions.ts`, `resolveMentions`, notifications | optional **M10** groups tables | — | unit, D1 fan-out | — | D13 |
| 13.4 | Share passwords | `worker/public.ts`, `worker/password.ts` | **M11** `shares.password_hash`, `password_salt` | — | D1 throttling | 9.7 | — |
| A | Activation tooling | new `scripts/access-*.mjs`, runbook | none | — | fixture tests | R3, 7.3 | D11 |

## 2. Shared hot spots (coordinate changes here)

| Hot spot | Changed by | Rule |
|---|---|---|
| `shared/views.ts` `evalFilter` / `fieldValue` | R1, 7.1, 12.1, 12.2 | Keep one evaluator for client, MCP, automations and metrics. Add a parity test with every change |
| `shared/dates.ts` | R1, 7.1, 7.2 | Date-only strings at UTC midnight; timezone only via `workspaceToday` / `toDateOnlyInZone` |
| "today" call sites | 7.2 | One helper per side; no new `new Date().toISOString().slice(0,10)` |
| `worker/mcpReadTools.ts` `dashboard_snapshot` | 8.1–8.6, 8.13, 12.1 | Every new block type evaluated with the same shared function |
| `shared/aiCapabilities.ts` + `tests/assistant-registry.test.ts` | 8.1, 8.10, 9.4 | Exact set match; read flag must equal `readOnlyHint` |
| `worker/mcp.ts:674` significance rule | 7.4 (upgrade), any new bulk or destructive write | Significant writes become previews |
| `worker/reminders.ts` scheduler | 10.2/10.4 (phase 10), 8.10 (timing writes) | Update `SCHEDULED_PHASE_COUNT` and the rotation test; stay on one cron |
| `worker/auth.ts` `UserPrefs` / `sanitizePrefs` | 10.2–10.4, 9.4 (new kind) | Backward compatible with `'inbox'|'off'` |
| `worker/mutationAccess.ts` | 9.4 | Security-sensitive; extend the capability matrix test |
| `worker/public.ts` `activeShare` / `shareFor` | 9.7, 13.4 | All public routes go through it |
| `src/core/sync/engine.ts` | 8.9, 9.2, 9.5, 13.2 | `mutateMany` shares `mutate` internals; one transaction |
| `templates/tcg-pack.json` | 7.2, 7.4, 8.x | Every change ships through the 7.4 upgrade with stable keys; bump the pack `version` |
| `scripts/release-preflight.mjs` + test, `migrations.json`, rehearsal | every migration and flag | Counts and the optional-disabled list kept exact |
| UX lab references | every new screen | Re-record only changed surfaces; add matrix cells |

## 3. Expected migration sequence

Assign the actual number at implementation. Each is additive; update the
manifests per README §5.

| Seq | Expected file | Phase |
|---|---|---|
| M1 | `0035_workspace_settings.sql` | 7.2 |
| M2 | `0036_scheduler_runs.sql` (optional) | 8.10 |
| M3 | `0037_search_updated_at.sql` | 9.6 |
| M4 | `0038_share_expiry.sql` | 9.7 |
| M5 | `0039_user_email.sql` | 10.1 |
| M6 | `0040_email_outbox.sql` | 10.2 |
| M7 | `0041_push_subscriptions.sql` | 10.4 |
| M8 | `0042_file_storage.sql` | 11 |
| M9 | `0043_automation_branch.sql` | 12.4 |
| M10 | `0044_mention_groups.sql` (only if D13 = groups) | 13.3 |
| M11 | `0045_share_passwords.sql` (only if requested) | 13.4 |

## 4. New MCP tools and AI catalog entries

| Kind | Id | Classification | Phase |
|---|---|---|---|
| Tool | `attention_queue` | `R(…,'dashboards')` | 8.1 |
| Tool | `automation_health` | `R(…,'automations')`, admin-only at the handler | 8.10 |
| Tool | `resolve_comments` | `W(…,'comments')` | 9.4 |
| Tool change | `install_template` `mode:'upgrade'` | unchanged W; significant | 7.4 |
| Tool change | `add_view`, `update_view`, `query_records` (`within`, relative dates, chart) | unchanged | R1, 7.1, 12.3 |
| Tool change | `website_query` (`queue`), `website_digest` (bands) | unchanged R | 8.3 |
| Tool change | `search` (date params) | unchanged R | 9.6 |
| Tool change | `publish_page`, `share_moodboard` (`expiresInDays`) | unchanged H | 9.7 |
| Tool change | `dashboard_snapshot` (new block types) | unchanged R | 8.x |
| AI action | `triage_my_attention`, `summarize_project_health`, `explain_budget` | `shared/aiActions.ts` | 8.x |

## 5. New feature flags and secrets (all default OFF; preflight coverage)

| Name | Type | Phase |
|---|---|---|
| `EMAIL_PROVIDER` (`none`/`resend`/`simulated`) | var | 10 |
| `RESEND_API_KEY`, `EMAIL_LINK_KEY` | secrets | 10 |
| `EMAIL_FROM` | var | 10 |
| `WEB_PUSH` (`off`/`on`/`simulated`) | var | 10 |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | vars | 10 |
| `VAPID_PRIVATE_KEY` | secret | 10 |
| `FILE_STORAGE` (`d1`/`r2`), `FILE_QUOTA_MB` | vars | 11 |
| `FILES` | R2 binding (commented until the owner creates it) | 11 |

## 6. New server-only tables (add to the AGENTS.md list)

`workspace_settings`, `scheduler_runs` (optional), `email_verifications`,
`email_outbox`, `push_subscriptions`, `mention_groups` and
`mention_group_members` (optional).

## 7. New dashboard block types

`attention`, `projecthealth`, `budget` (modes `project`, `product`),
`fieldsessions`, `measurechart`, `commitments`. Each needs: registry, Configure panel, states,
drill-down, `dashboard_snapshot` support, and UX lab cells.

## 8. User-visible module map after all phases

| Module or surface | Gains |
|---|---|
| Home | attention, my work, multi-source calendar, activity, AI review, reliability chip |
| Databases | `within` dates, currency formats, bulk edit, CSV import/export, attention config, (12) rollups, formulas, chart view |
| Website | queues, bands, owner and follow-up, bulk triage, reply drafts (copy only) |
| Projects / Finance / Field / Community / Editorial | desk pages and focused blocks |
| Comments | resolve and reopen |
| Pages | Markdown and print export, share expiry and rotation, (13) passwords |
| Search | date filters |
| Settings | Workspace (locale), email and push, digest, reliability, recent imports and bulk edits, shares list, admin disable |
| Automations | health tab, (12) branches |
| AI (`/ai`) | unified review desk |
