# Website integration deployment and recovery runbook

This is preparation only. Remote migrations, resource creation and deployment require separate authorization.

## Source and migration order
1. Review the Workspace integration PR stacked on feature/unified-ai-mcp; retain existing release PRs #12/#13 unchanged.
2. Back up the intended Workspace and relay D1 databases using the operator's verified account/resource identifiers. Confirm restoration on isolated copies before release.
3. Apply all Workspace migrations in order: release 0032_assistant_conversations.sql, 0033_website_ingest.sql, then 0034_website_source_authority.sql. The manifests pin immutable bytes. Apply relay 0001, 0002 and 0003_delivery_outbox.sql.
4. Deploy compatible receiver/relay code only under separate authorization. Keep forwarding explicitly disabled until both database/schema and authority setup are ready.

## Configuration
Workspace: WEBSITE_INGEST_SECRET (secret), WEBSITE_INGEST_ENABLED=true. An authenticated administrator PUTs /api/admin/website-ingest with the authorized spaceId and optional existing peopleId. The authenticated user sponsors the service; default Inbox/People IDs are returned by GET. Sponsor permissions and grant version are fenced on every ingest transaction. DELETE revokes.

Relay: PATRON_DB must bind the intended database. Set FORWARD_ENABLED=1, exact HTTPS FORWARD_URL, and FORWARD_SECRET matching the receiver. Existing Resend, Razorpay and admin credentials stay secrets. Partial configuration returns recoverable errors, never silent email-only fallback. FORWARD_ENABLED=0 deliberately preserves email-only behavior.

The one-minute cron dispatches bounded due batches. Monitor pending/failed counts and oldest due time through protected delivery-list. delivery-replay accepts only an existing event ID; it never changes payload or destination. Restore receiver authority/configuration before replaying authorization-related failures. Terminal conflicts require investigation, not editing the immutable stored event.

## Email and privacy
Keep provider receipts and first-attempt times. A lost acknowledgement can retry the identical provider request within 24 hours. Beyond that window an uncertain outcome requires operator reconciliation; never blindly resend. Delivered/accepted bodies expire after 30 days; receipts remain for deduplication. Pending/failed payloads require explicit resolution. Export/erase includes new storage and waits for active send leases. Owner confirmation of retention/privacy wording remains required before launch.

## Rollback and ownership
Pause forwarding explicitly before a planned rollback; export/reconcile outstanding events. Revert code only to a version compatible with migrated schemas. Do not drop additive tables, erase receipts or renumber shipped migrations. Restoring an old database can resurrect previously processed events, so reconcile stable IDs/receipts before resuming. Avoid repeating an uncertain payment, email or mint operation.

backend.enabled, featured.show_samples and policy draft flags remain unchanged. CA review, provider activation, production-domain redirect checks, real-device/screen-reader acceptance and chain operations are separate gates.

## Evidence and review
Run npm run certify:ai on clean committed Workspace source; use the current mandatory manifest. Run relay and cross-repository checks against the recorded website SHA. Record every exit, fixture ID, browser/OS version and both source fingerprints. Local logs contain synthetic fixtures only; publish sanitized summaries and hashes. A genuine person must review frozen changes in the browser; test session approvals are not human acceptance.

## Identity recovery
Restore a Person with the existing authorized restore workflow. To rebind a reserved email explicitly, an administrator can POST `/api/admin/website-ingest/people-rebind` with the normalized email and an existing active `personId` in the configured People database. The target must have that email. Rebinding is audited, session/grant/revision fenced, and applies to future submissions. It never resurrects or creates a Person.
