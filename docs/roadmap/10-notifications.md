# Phase 10 — Notifications outside the app

Branch `sol/p10-notifications` stacked on `sol/p9-everyday`. Depends on 8.1
(the attention queue feeds the digest) and 7.2 (workspace "today" and
timezone).

**Owner prerequisites** (Sol prepares; owner executes):
- D7: Resend account and verified sending domain (SPF/DKIM/DMARC DNS);
  `RESEND_API_KEY` secret; `EMAIL_FROM`.
- D8: VAPID key pair (`npx web-push generate-vapid-keys` or the script in 10.4);
  `VAPID_PRIVATE_KEY` secret, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` vars.

Until then everything runs with `EMAIL_PROVIDER=simulated` / `WEB_PUSH=simulated`
locally. Results are labelled simulated.

The website relay already uses Resend (`services/form-relay/src/index.js` in the
website repo). Use the same provider; do not import relay code. The Workspace
gets its own small client.

---

## 10.1 Verified email address per account

- **Migration:**
  - `ALTER TABLE users ADD COLUMN email TEXT;`
  - `ALTER TABLE users ADD COLUMN email_verified_at INTEGER;`
  - `CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;`
  - A new table `email_verifications(user_id PRIMARY KEY, email, code_hash, expires_at, attempts)`.
- **API** (`worker/auth.ts` or a new `worker/email.ts`):
  - `POST /api/me/email {email}` stores the pending address and sends a 6-digit
    code (hashed; 15-minute expiry; 5 attempts; rate-limited with the existing
    `rate_limits` table).
  - `POST /api/me/email/verify {code}` sets `email` and `email_verified_at`.
  - `DELETE /api/me/email` removes it.
  - Never reveal whether an address is used by another account; the response is
    the same either way.
- **Security:**
  - Changing or removing the email does not change the password.
  - The email is never shown to other members (People directory privacy).
  - Guests may add one.
- **UI:** Settings → Profile gets "Email for notifications" with the verify flow.
- **Tests:** D1 for the code lifecycle, rate limit, uniqueness without
  disclosure, and expiry.

## 10.2 Email delivery channel

- **Preferences** (`worker/auth.ts:94` `UserPrefs`, `sanitizePrefs`). This is
  the one shape for all of Phase 10:
  - The per-kind value becomes
    `'off' | 'inbox' | ('inbox' | 'email' | 'push')[]`.
    - Legacy `'inbox'` equals `['inbox']`; `'off'` stays `'off'`.
    - An array always includes `'inbox'`, because email and push supplement the
      Inbox and never replace it.
    - `sanitizePrefs` normalizes unknown entries away and keeps the legacy
      strings valid.
    - Add a helper `channelsFor(prefs, kind): Set<'inbox'|'email'|'push'>`;
      `kindAllowed` becomes `channelsFor(...).has('inbox')`.
  - Add `emailDigest: 'off' | 'daily' | 'weekly'` (default `off`) and
    `digestHour` (0–23 local, default 7).
  - Add `pushShowContent: boolean` (default false; 10.4).
- **Outbox table (migration):**
  ```sql
  CREATE TABLE email_outbox (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
    notification_id TEXT, digest_key TEXT, target_id TEXT,
    created_at INTEGER NOT NULL, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER, provider_id TEXT, last_error TEXT, terminal_at INTEGER,
    UNIQUE(user_id, digest_key)
  );
  CREATE INDEX idx_email_outbox_pending ON email_outbox(sent_at, terminal_at, created_at);
  ```
  This is a server-only table; add it to AGENTS.md.
- **Enqueue.**
  - In `notify()` (`worker/notifications.ts:91`), when prefs say `'email'` for
    the kind and the user has a verified email, add an `INSERT INTO email_outbox`
    to the SAME statement batch (the existing `transaction` parameter), so
    notification and email are atomic.
  - Urgent kinds (`approval_requested`, `mention`) also request an immediate
    send with `ctx.waitUntil` when an ExecutionContext is available (best
    effort; the cron is the guarantee).
- **Send phase.**
  - Add scheduler phase 10 "email" to `runScheduled` (`worker/reminders.ts`).
    Update `SCHEDULED_PHASE_COUNT` to 10, the inventory, and the rotation test.
  - It claims at most 10 pending rows with a lease, then for each:
    1. **Recheck at send time:** the user is not disabled, the email is
       verified, the pref is still `'email'`, and the target is still readable
       (`createReadGate(db,userId).decide([target])`). If not readable, send the
       generic body "You have a new notification in TCG Workspace" with a link
       to `/inbox`, never the stored title.
    2. **Render** a plain-text and minimal HTML body: one line and a button
       link to the app URL. Include a `List-Unsubscribe` header and a footer
       link. No record body text.
       - The record title is included only when the workspace setting
         `emailShowTitles` is true (owner decision D7; add a boolean column to
         `workspace_settings` in this phase's migration, default false) and the
         target is readable at send time.
       - Otherwise use the kind's generic text ("You were mentioned", "An
         approval needs you").
    3. **Call the provider.** Egress only to the exact host `api.resend.com`,
       with `redirect:'error'` and an idempotency key = `email_outbox.id`
       (copy the `egress()` pattern from `worker/assistant/providers.ts`).
    4. Record `sent_at` and `provider_id`. Retry with backoff using
       `retryDelay` from `worker/execution.ts`; after 8 attempts set
       `terminal_at`. Errors are logged without the address.
  - Budget: at most 10 sends × 2 D1 calls + claim ≤ 24 calls; phase minimum 24.
- **Unsubscribe.**
  - Signed token: HMAC with a new secret `EMAIL_LINK_KEY` over
    `user_id + kind + exp`.
  - `GET /api/email/unsubscribe?t=` shows a confirmation page; POST applies
    (kind → `'inbox'`, or digest → `'off'`). There is no login, because the
    token proves intent.
- **Feature flags:**
  - `EMAIL_PROVIDER` (`none` default | `resend` | `simulated`);
  - `simulated` is allowed only when `WORKSPACE_ENV==='local-test'`;
  - add both to the release preflight optional-disabled list.
- **Retention:** sent rows are deleted after 30 days, terminal rows after 90 (in
  `runRetention`).
- **Tests:**
  - D1 in `tests/phase10-email-d1.test.ts`: atomic enqueue; send-time
    recheck (revoked access → generic body); disabled user → no send; lease and
    retry; terminal state; idempotency key stable; unsubscribe token
    tamper/expiry; budget.
  - Unit: rendering escapes HTML.
  - No real email in tests: a simulated provider records requests.

## 10.3 Email digest

- `shared/digest.ts` `buildDigest(attentionItems, unread, today)` returns
  sections:
  - "Needs you" (severity ≥2);
  - "Due today";
  - "New on the Website inbox" (admins/triagers);
  - "Unread mentions".
  - Each item is title + link, with restricted items omitted. Empty digests are
    not sent.
- **Daily or weekly enqueue** inside the email phase:
  - for users with `emailDigest` set, whose local `digestHour` has passed today
    (workspace timezone) and with no row for `digest_key = 'd:'+date` (or
    `'w:'+isoWeek`), enqueue one row;
  - the content is computed at send time from the 8.1 collector, so it is
    always current and gated.
- **UI:** Settings → Notifications gets a digest frequency and hour, plus
  "Send me a test digest" (simulated locally; real only after the owner
  configures the provider).
- **Tests:** unit for sections; D1 for once-per-day dedupe across rotating
  phases and the timezone boundary.

## 10.4 Web push (installed app enhancement)

- **Migration:**
  ```sql
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_ok_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, user_agent TEXT
  );
  ```
- **Client:**
  - Settings → Notifications gets "Notifications on this device": request
    permission on a user click only, then `pushManager.subscribe` with
    `VAPID_PUBLIC_KEY`, then `POST /api/push/subscriptions`.
  - Show capability states: unsupported; iOS not installed (explain "Add to Home
    Screen first"); denied; enabled.
  - Unsubscribe on sign-out and account switch.
- **Service worker** (`src/sw.ts`, must remain classic-script safe):
  - a `push` handler that shows a notification with generic text unless the
    payload includes a title (see the privacy rule below);
  - `notificationclick` opens or focuses the app URL from the payload (same
    origin only).
- **Server:**
  - `worker/webpush.ts` implements RFC 8291 (aes128gcm) payload encryption and
    RFC 8292 VAPID JWT with WebCrypto. There is no Node library. Use the RFC
    test vectors as unit tests.
  - **Egress allowlist.** Endpoints are user-supplied, so `POST
    /api/push/subscriptions` must reject any endpoint whose host is not a known
    browser push service. Store and send only to:
    - `fcm.googleapis.com` (Chrome, Edge, Android);
    - `updates.push.services.mozilla.com` (Firefox);
    - `web.push.apple.com` (Safari, iOS);
    - hosts matching `*.notify.windows.com` (legacy Edge, WNS).
    The list is a constant in `worker/webpush.ts` with a test; https only.
    Re-check the host at send time, and use `redirect:'error'`, a 5 s timeout
    and no credentials. This keeps the project's exact-host egress rule intact.
  - 404/410 deletes the subscription; other failures increment `failures`;
    5 failures deletes it.
- **Delivery:** the same enqueue point as email, when
  `channelsFor(prefs, kind)` contains `'push'` (the shape is defined in 10.2).
  Push rows go into `email_outbox` with `kind` prefixed `push:`, or a sibling
  `push_outbox` table with the same columns; choose one and document it.
  Sending happens in the same scheduler phase as email, a separate loop,
  capped at 10.
- **Privacy rule:** the push payload contains a title only when the target is
  readable at send time and `pushShowContent` is true (default off). Otherwise
  the text is "New activity in TCG Workspace".
- **Flags:** `WEB_PUSH` (`off` default | `on` | `simulated`); preflight
  coverage.
- **Tests:** unit RFC vectors; D1 subscription lifecycle and send-time gate;
  browser (Chromium and Firefox) permission-granted flows with a local push
  stub; WebKit marked NOT RUN for real push (state it).
- **Owner script:** `scripts/generate-vapid-keys.mjs` prints a key pair locally
  (no network).

## 10.5 Out of scope

- SMS and WhatsApp.
- Email replies to the Website inbox (a separate owner-authorized integration).
- Marketing email.
- Read receipts.
