# Phase 10 notification architecture

The Inbox remains authoritative. Channel selection extends UserPrefs through
the existing authenticated profile update and its compare-and-swap fence.
Email addresses and verification challenges stay outside synced records.

The notification transaction enqueues email and push in the server-only
email_outbox. Email stores a stable payload hash and provider receipt.
Digest content comes from the gated attention collector at send time.
Titles default off and require current access before egress.

Push rows identify one push_subscriptions record and use a push: kind.
Subscriptions belong to a live session. The registration limit is ten devices
per account. Delivery and receipt commits compare the current session and keys,
so a late provider response cannot affect a renewed subscription.

The classic service worker and client share the workspace-push-device
IndexedDB database. It holds an account ID and session hash, and changes no
Dexie schema or synced collection. The worker checks this marker before
displaying or opening a notification. Cleanup compares the expected session.
Enable replaces a leftover browser subscription when its local identity is
missing or differs from the active session, preserving the server's
cross-account ownership refusal.

The existing rotating cron handles bounded delivery and digest scheduling.
Channel priority alternates to preserve recovery progress. Both providers
default off. Simulated sinks are restricted to disposable local fixtures and
rejected by release preflight.

Implementation requirements and acceptance are in
../roadmap/10-notifications.md. Owner setup, retention, monitoring and rollback
are in ../roadmap/10-notifications-runbook.md. Evidence, failed attempts and
current source checkpoints are indexed in ../roadmap/PROGRESS.md.
