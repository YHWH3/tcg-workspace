# Integrated release: owner execution checklist

Preparation only. No operation below has been executed against a remote service.
The implementing session may run the local rehearsal; the owner separately
authorizes and executes staging, merges, backups, migrations and deployment.
Keep production writes paused until configuration and validation finish. There
is no built-in maintenance switch: agree an ingress/writer pause first, including
offline clients, MCP writers, relay forwarding and scheduled work.

## Source and acceptance

Merge order, when approved: Workspace #12 → #13 → #14 → the R1 draft PR. Retarget
each successor to `main` after its base merges. Never merge superseded #7/#9.
The implementing session leaves all those PRs unchanged. R1 has no migration:
existing `today+30` filters start working through the shared evaluator.
R1 keeps UTC. The owner selected Asia/Kolkata and INR for Phase 7.2; that
branch has its own acceptance and migration requirements below.

Before deployment, run `npm run certify:ai` again on clean merged `main`, retain
the exact SHA/tree/fingerprint, mandatory gate table and Safari simulator results.
A prior branch certificate cannot certify the merged source. Record physical
hardware, human assistive technology and genuine approval separately.

## Ordered owner procedure

| Step | Owner action | Verification before continuing | Recovery if it fails |
|---|---|---|---|
| 1 | Resolve D12: relay retention/privacy wording, CA review of Patron terms/refunds/delivery, sample cards and backend enablement. Record responder, maintenance window, RPO/RTO and target resources. | Written decisions; verify flags in website source. Samples and policy draft flags are still unchanged. | Keep launch gated; no payment/token activation. |
| 2 | Record currently deployed Worker versions/configuration, D1 migration ledgers, file-byte counts, KV namespaces/grants, DO/session recovery plan and target account. Historical inventory is not current live state. | Exact resource identifiers and recovery point stored privately. Check intended target in source and built configuration. | Stop on any mismatch. Do not guess a target or use production as staging. |
| 3 | Export **both** production Workspace D1 and relay D1; preserve file chunks. Store backups outside Git, mode 0600 in a private directory. Capture KV recovery separately without publishing grants/secrets. | Hash exports; prove each backup can restore on an isolated copy. Verify source counts and file-byte totals. | Retain originals; resolve backup/restore failures before migration. Local Miniflare is not remote Time Travel proof. |
| 4 | Run the local SQL-copy rehearsal below against the Workspace export. It requires the export's `d1_migrations` ledger to be an exact registered prefix. | Report PASS, original record/file values preserved, pending migrations applied, permissions off, real bounded search/date backfills and closed-copy restore passing. | HOLD on failure. Fresh copies and protected reports are retained; input is never overwritten. |
| 5 | Separately inventory OAUTH_KV. The historical snapshot reported two legacy grants without connection IDs. D1 cannot prove their current number or state. Plan reconnecting Claude and ChatGPT. | Owner verifies current grants and approved reconciliation/revocation procedure. No grant values in evidence. | Preserve KV backup; do not delete grants blindly or treat a D1 PASS as KV verification. |
| 6 | Owner creates a temporary staging Worker, D1, KV and appropriate DO namespace, using independent resources and private synthetic/sanitized data. Build for the exact reviewed target. | Inspect source and flattened Vite config. No production bindings, fixture bypass variables or real inference. No public tunnel. | Discard only owner-confirmed disposable resources; never repoint staging to production. |
| 7 | Apply staging migrations/config, deploy compatible staging assets/Worker, then run smoke and the applicable `verify-*` suites against a reviewed staging-only configuration. | Full smoke, OAuth consent/reads, permissions-off sync, search/date backfills, forms recovery, previews/approval/undo and Website ingest checks. Review scripts first: many deliberately require local fixtures and must not simply be pointed at staging. Prepare staging adapters preserving assertions where needed. | Fix on a new branch, recertify affected source, repeat staging. Staging adapters/results remain an owner gate until actually run. |
| 8 | After backup and staging acceptance, apply only pending production Workspace migrations through `0034_website_source_authority.sql`, in manifest order. Relay requires `0001`–`0003_delivery_outbox.sql`. Never edit or renumber shipped SQL. | Read back ledger and schema; validate FK/JSON/counts/Core membership, disabled access, search/date backfills, share pinning and durable journals. There are 34 Workspace migrations at this release. | Stop at the committed ledger boundary. Retain additive schema. Use rehearsed restore if necessary; reconcile post-backup writes first. |
| 9 | Deploy reviewed Workspace Worker and frontend together. Keep traffic paused. Set required protected secrets/configuration and verify the resulting deployed version, because secret updates can create a new deployment. | `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES`; `WEBSITE_INGEST_SECRET`, `WEBSITE_INGEST_ENABLED=true`. `AI_CREDENTIAL_KEY` only if separately choosing BYOK. Confirm one Workspace `*/15` cron. Readiness must fail closed before configuration. | Disable ingest/forwarding and restore compatible Worker/config; do not revert to code incompatible with migrated schema. Never paste secret values into logs or commands. |
| 10 | Sign in as the intended active administrator and configure the sponsored Website ingest grant in Settings → Admin. Deploy relay with `FORWARD_ENABLED=0`; configure `PATRON_DB`, matching `FORWARD_SECRET` and exact HTTPS `FORWARD_URL`, then explicitly enable forwarding. | Grant GET returns intended sponsor/space/Inbox/People and current authority. Relay migrations present; its one-minute cron active. Check authenticated delivery-list pending/failed/oldest-due without exposing bodies. | Switch forwarding off for planned recovery, preserve stable event IDs/receipts and queued payloads; restore receiver authority before replay. Do not edit stored event content or retry conflicts blindly. |
| 11 | Owner authorizes one synthetic real-origin form submission and checks email receipt and Workspace record, answer completeness and People relationship. Reconnect Claude and ChatGPT against the intended origin/scopes. | One event/record/receipt, no duplicate on retry, successful scoped reads and pending proposal; separate genuine human approval only if chosen. | Preserve submission identity; inspect outbox/receipt. Email uncertainty after 24 hours requires reconciliation, never an automatic resend. |
| 12 | Resume writers under monitoring and record final versions, counts and checks. | Permissions remain off. `AI_PROVIDER=none`, `AI_DAILY_UNITS=0`, no classification/chat/BYOK activation. Workers AI/transcription, payments and token minting remain unavailable until separately authorized; remove/withhold optional bindings in reviewed release config if necessary. | Pause affected ingress/forwarding, preserve data and execution checkpoints, follow tested compatible-code/backup recovery. |

Do not run `npm run deploy` as a local test: repository Wrangler configuration
targets production. There is no ready-made staging environment. Vite environment
selection happens at build time; inspect both source configuration and generated
deployment configuration.

## Local rehearsal the implementing session can run

```sh
# Local only. Input is an owner-exported regular SQL file, at most 64 MiB.
node scripts/prod-copy-rehearsal.mjs /absolute/private/path/workspace-backup.sql
```

The script never loads a remote Wrangler target. It copies the input into a
new mode-0700 ignored artifact directory, imports into local Miniflare D1,
applies only pending manifest-pinned migrations, runs the actual Worker search
and date indexers within the 45-binding-call budget, and restores a closed
pre-upgrade copy. Reports contain counts/hashes only; the private input and D1
state still contain sensitive data. Keep the entire directory local. A failure
returns HOLD/nonzero and preserves the original input and failed evidence.
It refuses URLs, symlink input files, truncated SQL and unexpected migration
ledgers. It is not a generic remote restore tool or a proof of KV/DO recovery.

Only a **synthetic** 0001–0003 export has been tested by this implementation.
The owner production export, relay restore, staging run and production recovery
are NOT RUN until their actual results are recorded.

## Email, privacy and rollback cautions

Accepted email receipts must never trigger an automatic resend. Reuse the
immutable provider payload/idempotency key only within its supported window;
unknown outcomes beyond 24 hours require operator reconciliation. Delivered
outbox and accepted email bodies currently purge after 30 days; pending/failed
bodies stay recoverable. Owner privacy/retention sign-off is required. Export
and erase include outbox storage and wait for active leases.

Database restore can resurrect previously processed events or lose intervening
writes. Reconcile event IDs, provider receipts, payment references, previews and
execution journals before resuming. Do not drop tables, purge receipts or repeat
uncertain external operations to make recovery appear successful. D1 restore
does not restore KV grants, DO/session state or already delivered bytes.

References checked for preparation: Cloudflare [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
[D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
Repository contracts: `docs/releases/1.0.0-candidate.md` and
`docs/integration-release/RUNBOOK.md`. Those older documents remain historical;
the ordered inventory here includes migrations 0032–0034 and the sponsored grant.

Cloudflare currently documents that full SQL export is unsupported when a database contains virtual tables (including FTS). The historical 0001–0003 database predates FTS. If the live schema has changed and export refuses, stop and obtain an owner-reviewed backup method; never delete live virtual tables merely to obtain an export. The copy rehearsal does not make that provider restriction disappear.

## Phase 7.2 settings prerequisite (when its separate PR is accepted)

The R1 certificate does not certify the Phase 7 branch. Include that branch only
through its own review and fresh merged-source certification. Phase 7.2 adds
`0035_workspace_settings.sql` after 0034; keep prior migration contents and hashes.
The new table is server-only and requires no new binding, environment flag or secret.

1. Apply the registered migrations to the isolated staging copy first, using the
   backup/rehearsal procedure above. `GET /api/workspace/settings` must return a
   valid versioned row. A missing table/row is a migration/configuration failure.
2. The migration preserves UTC, INR and Monday. Sign in as a current canonical
   owner/admin and use Settings → Workspace to select Asia/Kolkata and INR.
   Keep Monday unless the owner selects another week start. Settings are human-only;
   there is no MCP settings write tool. A stale version requires a fresh read.
3. Verify app, MCP overview/query/dashboard, reminders, date-offset work and
   digest use the same civil date around the Kolkata midnight boundary. Verify
   explicit USD fields still say USD. Defaults label their assumed currency;
   display changes perform no currency conversion.
4. Record prior settings and version privately. To reverse a configuration choice,
   save the prior values using the latest version. Keep reminder/run dedupe history;
   settings rollback does not retract already delivered notifications. Follow the
   compatible-code/backup procedure for schema rollback rather than deleting tables.

Frontend caches are account-bound. Online changes refresh through the existing
live connection; known offline settings remain in use. Before a first successful
fetch, the app explicitly identifies its device-date fallback when unavailable.
Provider usage quotas and audit/export timestamps retain their intentional UTC
meaning. No real workspace settings were changed during local verification.
