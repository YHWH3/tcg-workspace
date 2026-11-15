# Phase 10 notification operation

This runbook prepares owner activation. Local certification uses simulated
providers and disposable data. Production activation requires the owner's
approved release process.

## Source and migrations

Use the reviewed Phase 10 PR and its source-specific evidence in PROGRESS.md.
Back up the approved database before applying migrations in registered order.
Phase 10 adds 0039_user_email.sql, 0040_email_outbox.sql and
0041_web_push.sql. Preserve every earlier migration and manifest hash.
The new delivery and subscription tables stay server-only.

## Email

The default EMAIL_PROVIDER is none. Resend activation needs a verified sender
and the configuration names EMAIL_PROVIDER, EMAIL_FROM and EMAIL_APP_ORIGIN.
EMAIL_APP_ORIGIN must be the exact HTTPS origin of the Workspace.
RESEND_API_KEY and EMAIL_LINK_KEY belong in approved secret storage.
EMAIL_LINK_KEY signs verification and unsubscribe tokens. Rotating it
invalidates outstanding links.

Users verify their own address in Profile, then select Inbox and email per
notification type. Daily and weekly digests have a separate opt-in and local
hour. The workspace timezone controls scheduling. The configured hour is the
earliest eligible time. The existing rotating cron and recovery work determine
the eventual send time. Weekly keys use the Monday date.

D7 permits administrators to enable readable titles in Workspace settings.
The initial value is off. Answers, record bodies and historical notification
copies stay out of email. The sender rechecks recipient state and current
record access before a title can leave the Worker.

Resend retries use the same idempotency key and payload hash. An uncertain
request outside the provider window, or a changed payload, enters a terminal
review state. Inspect the sanitized status before deciding any manual recovery.
An empty scheduled digest is an explicit skipped outcome.

## Device push

The default WEB_PUSH is off. The owner-run script
`node scripts/generate-vapid-keys.mjs` generates a key pair locally. Keep its
private output out of chat, logs, version control and published evidence.
VAPID_PRIVATE_KEY belongs in approved secret storage. VAPID_PUBLIC_KEY is the
browser subscription key. VAPID_SUBJECT supplies the owner's mailto or HTTPS
contact address. Review these values before enabling WEB_PUSH=on.

Users enable each device and choose Push for the desired notification types.
Permission is requested after their button click. On iPhone and iPad, the UI
explains Safari's Add to Home Screen flow when installation is required.
pushShowContent defaults off and controls readable titles independently of
email's administrator setting.

Endpoints are constrained to the hosts in worker/webpush.ts. Delivery uses
encrypted payloads, denies redirects and has a five-second request timeout.
404/410 removes the subscription. Five service failures remove it as well.
Each device delivery has an expiring lease and a stable notification tag.
The tag lets browsers replace uncertain duplicate deliveries.

Subscriptions belong to the requesting session. Revocation, expiry, account
disablement and current channel preferences are checked at send time.
The browser clears its local notification identity on sign-out and account
switch, and the service worker withholds notifications for another identity.
Never treat a stubbed browser permission result as real OS delivery.

## Monitoring, retention and rollback

Inspect email_outbox for counts by sent_at, terminal_at, last_error and
next_attempt_at. Inspect subscription failure counts without exporting endpoint
tokens or encryption secrets. Logs contain operational summaries only.
Sent delivery rows expire after 30 days and terminal rows after 90 days through
the existing retention job. Account deletion cascades into retained delivery
and subscription data.

To stop a channel, restore EMAIL_PROVIDER=none or WEB_PUSH=off through the
owner's release process. Keep the additive schema and pending rows during
code rollback so data can be inspected and recovered. Preserve database
backups and verify the prior binary against the retained schema locally before
an owner rollback.

EMAIL_PROVIDER=simulated, WEB_PUSH=simulated, EMAIL_TEST_SINK and PUSH_TEST_SINK
are disposable local fixtures. Release preflight rejects these settings.
Live sender setup, provider delivery, real push on supported OS versions,
physical devices and manual accessibility review remain owner acceptance gates.
