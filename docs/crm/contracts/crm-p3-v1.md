# TCG CRM P3 Contract — Communications (S5, S11, S12)

**Status:** Normative local development contract for Package P3 (`S5: Zoho Mail`, `S11: WhatsApp Cloud API`, `S12: Instagram & Facebook Messaging`).
**Governing sources:** `AGENTS.md`, `docs/crm/01-DECISIONS.md` (`A-19`–`A-28`), `docs/crm/06-DATA-MODEL.md`, `docs/crm/07-CONTRACTS.md`, `docs/crm/09-TRANSACTIONS.md`, `docs/crm/11-ROADMAP.md`, `docs/crm/12-OPEN-DECISIONS.md`.

---

## 1. Transport Posture & Production Safety

1. **Production adapters disabled by default:** Every channel account defaults to `mode = 'disabled'` (`active = 0`). Production provider HTTP calls execute **only** when `account.mode === 'production'`, `account.active === 1`, the Worker secret named by `account.secret_name` is bound, and egress passes an exact host allowlist with `redirect: 'error'`.
2. **Simulated transport restricted to local-test:** Simulated sending, polling and webhook helpers run **only** when `WORKSPACE_ENV === 'local-test'`. Simulated tests verify internal state machines, consent, windows, deduplication, leases, retries, review workflows and authorization — **they never establish real provider compatibility**.
3. **Human-only sending preserved:** `message.send`, `message.retry` and `message.resolve_review` require `via === 'ui'`, `crm.access`, and `crm.send:<channel>` (or `crm.channels.manage` for account/template administration). Neither MCP nor automations may send external messages or use Meta's `HUMAN_AGENT` tag.
4. **No secret values in D1 or API responses:** `crm_channel_accounts.secret_name` stores only the environment binding name (e.g. `ZOHO_MAIL_CRED_JSON`, `WHATSAPP_CLOUD_CRED_JSON`, `META_MESSAGING_CRED_JSON`), never secret material or access tokens. OAuth tokens are never stored in module-level state.

---

## 2. Official Provider Rules Verified (Provider-Independent)

### 2.1 S5 — Zoho Mail (`email_zoho`)

- **Primary API:** Zoho Mail REST API v1 over OAuth 2.0 (`Authorization: Zoho-oauthtoken <access_token>`), using regional data-centre host allowlists:
  - API hosts: `mail.zoho.com`, `mail.zoho.in`, `mail.zoho.eu`, `mail.zoho.com.au`, `mail.zoho.jp`, `mail.zoho.ca`.
  - OAuth token hosts: `accounts.zoho.com`, `accounts.zoho.in`, `accounts.zoho.eu`, `accounts.zoho.com.au`, `accounts.zoho.jp`, `accounts.zoho.ca`.
  - OAuth scopes: `ZohoMail.messages.ALL` (or `ZohoMail.messages.CREATE` + `ZohoMail.messages.READ`), `ZohoMail.accounts.READ`, `ZohoMail.folders.READ`.
- **Send endpoint:** `POST https://mail.zoho.<dc>/api/accounts/{accountId}/messages` with `fromAddress`, `toAddress`, `subject`, `content`, `mailFormat: 'plaintext' | 'html'`, and reply threading (`inReplyTo` / `references` / reply endpoint when replying to an existing thread). No open/click tracking pixels or link wrapping (`P-16`).
- **Inbound polling:** Durable cursor (`poll_cursor`) and lease (`poll_lease_until`) per `crm_channel_accounts` row, bounded page fetch per cron tick inside the 45-call D1 budget. Every inbound email is deduplicated in `crm_inbound_events(channel, external_event_id)`.
- **RFC 5322 threading:** Inbound emails attach to an existing conversation **only** by matching RFC `In-Reply-To` or `References` headers against stored `crm_messages.rfc_message_id` (or matching `external_thread_id` within the same `channel_account_id`). Subject-only matching is **never** used so unrelated contacts with generic subjects (e.g. "Enquiry") never cross-thread.
- **Fallback posture:** IMAP/SMTP fallback remains documented for account activation if Zoho plan limits require it (`O-20`).

### 2.2 S11 — WhatsApp Cloud API (`whatsapp_cloud`)

- **Endpoint & host allowlist:** `https://graph.facebook.com/<apiVersion>/{phoneNumberId}/messages` (`graph.facebook.com` only, `redirect: 'error'`, `Authorization: Bearer <token>`).
- **24-hour customer service window:** An inbound customer message opens/resets a 24-hour (`86,400,000 ms`) window (`crm_conversations.window_expires_at`).
  - Inside the window: free-form text/service replies are allowed.
  - Outside the window: free-form replies are refused with `window_closed`; sending requires an `approved` template in `crm_templates` matching `channel = 'whatsapp'`.
- **Template mirroring:** `crm_templates` tracks `draft | submitted | approved | rejected | paused | retired`, `provider_template_id`, `language`, `category` (`utility | marketing | authentication`), `variables_json`, and `rejection_reason`.
- **Webhook security & idempotency:**
  - `GET /api/crm/webhooks/whatsapp`: verifies `hub.mode === 'subscribe'` and constant-time match of `hub.verify_token`, returning `hub.challenge`.
  - `POST /api/crm/webhooks/whatsapp`: verifies raw request body HMAC-SHA256 against `X-Hub-Signature-256` (`sha256=<hex>`) using constant-time comparison before parsing JSON.
  - Deduplicates every message (`wamid`) and status callback via `crm_inbound_events`.
  - Monotonic status progression: `queued < sending < sent < delivered < read` (late/reordered receipts never downgrade a higher terminal state).
- **Opt-out handling:** Inbound opt-out keywords (`STOP`, `UNSUBSCRIBE`, `CANCEL`, `OPTOUT`, `OPT OUT`) or provider opt-out events atomically append a `withdrawn` consent row on the resolved canonical person (`crm_consents` append-only) and cancel any `queued` non-transactional outbox items for that person & channel (`status = 'cancelled'`).

### 2.3 S12 — Instagram & Facebook Messaging (`instagram_meta`, `facebook_meta`)

- **Endpoint & host allowlist:** `https://graph.facebook.com/<apiVersion>/me/messages` (or `/{pageOrIgId}/messages`), `graph.facebook.com` only, `redirect: 'error'`.
- **Provider-scoped identities:**
  - Instagram uses Instagram-Scoped IDs (`igsid:<id>`).
  - Facebook Messenger uses Page-Scoped IDs (`psid:<id>`).
  - Page/IG-scoped IDs are **never** auto-merged across channels; linking to a Person record is explicit or via matching active endpoint for that exact channel.
- **Messaging windows & `HUMAN_AGENT` tag:**
  - Standard window: **24 hours** from last inbound user message (`window_expires_at`).
  - Human Agent window: **7 days** (`7 × 86,400,000 ms`) from last inbound user message (`human_agent_window_expires_at`), usable **strictly for human-authored UI replies** (`via === 'ui'`, never automated or AI-sent) with payload tag `HUMAN_AGENT` when the 24h window has elapsed and the channel account has `humanAgentApproved: true` configured.
  - Past 7 days (or when `HUMAN_AGENT` is not approved/enabled): refused with `window_closed`.
- **Webhook security:** Same GET handshake and raw-body `X-Hub-Signature-256` constant-time HMAC verification on `/api/crm/webhooks/instagram` and `/api/crm/webhooks/facebook`.

---

## 3. Outbox State Machine, Retries & Ambiguous Outcomes

- **States (`crm_outbox.status`):** `queued`, `sending`, `sent`, `failed`, `review_required`, `cancelled`.
- **Leasing:** Outbox workers lease due rows with `lease_until = now + 60_000` using conditional SQL updates + `changes() = 1` fences so concurrent cron/request sweeps never double-deliver.
- **Backoff & retry cap:**
  - Retryable error classes (`transient`, `rate_limited`): exponential backoff `30s -> 2m -> 10m` up to `max_attempts` (default `3`), then terminal `failed`.
  - Non-retryable error classes (`auth`, `window_closed`, `recipient_invalid`, `blocked`, `content_rejected`): immediate `failed` (zero automatic retries).
- **Ambiguous outcomes (`unknown`):**
  - Network timeout, transport drop after request dispatch, HTTP 5xx without confirmed non-delivery, or unparseable provider acknowledgment moves BOTH `crm_outbox.status` and `crm_messages.status` to `review_required`.
  - Automated sweeps **never** retry `review_required` rows (prevents duplicate customer messages).
  - A human with `crm.send:<channel>` verifies delivery in the provider console and executes `message.resolve_review` via UI (`resolution: 'confirm_sent'` with optional provider receipt, OR `resolution: 'mark_failed'` to unlock a deliberate human `message.retry`, OR `resolution: 'cancel'`).

---

## 4. Commands & Read Endpoints Added in P3

### Commands (`POST /api/crm/commands/<name>`)

| Command | Capability | Purpose |
|---|---|---|
| `channel.configure` | `crm.channels.manage` + admin/owner | Create or update a channel account (`mode` defaults to `'disabled'`; `'simulated'` allowed only in `local-test`) |
| `channel.set_mode` | `crm.channels.manage` + admin/owner | Enable/disable/disconnect a channel account (refuses `'production'` without required config & secret name) |
| `channel.poll_now` | `crm.channels.manage` | Bounded poll run for a pull-based account (Zoho Mail; simulated in `local-test`) |
| `template.upsert` | `crm.configure` or `crm.channels.manage` | Create/edit a draft message template |
| `template.submit` | `crm.channels.manage` | Submit template for provider approval (or update mirrored provider state in `local-test`) |
| `template.sync_status` | `crm.channels.manage` | Record mirrored approval/rejection/pause/retire status |
| `message.resolve_review` | `crm.send:<channel>` (UI only) | Human resolution of an ambiguous `review_required` outbound delivery |
| `outbox.process_now` | `crm.channels.manage` | Bounded manual sweep of due queued outbox items |

### Read Endpoints (`GET /api/crm/read/...`)

- `GET /api/crm/read/channels` — Channel accounts (sanitized config, never secret values), connection/health status, cursor/poll timestamps, templates, and recent delivery/outbox/review history (filtered by `ReadGate` for linked conversations).
- `GET /api/crm/read/templates?channel=` — Templates for the composer template picker and Settings -> Channels.

### Inbound Webhooks (Unauthenticated, Signature-Verified)

- `GET /api/crm/webhooks/:provider` & `POST /api/crm/webhooks/:provider` (`provider` in `whatsapp | instagram | facebook`): disabled (404) when `CRM_ENABLED` is off or no active matching account exists; verifies `X-Hub-Signature-256` against raw body before any DB write.

---

## 5. Pending Owner Decisions (Explicitly Unresolved)

These account-specific choices are **not invented** in P3 and remain pending owner confirmation before enabling any production account:

| ID | Decision Needed | P3 Behavior While Pending |
|---|---|---|
| `O-04` | WhatsApp number strategy (migrate current number vs dedicated number vs coexistence) | `whatsapp_cloud` production account remains `disabled`; phone number ID & WABA ID are configurable per account |
| `O-20` | Zoho Mail account details (data centre `.in`/`.com`/`.eu`, plan, API vs IMAP/SMTP, Sent sync) | `email_zoho` supports all official Zoho DCs via explicit allowlist; account remains `disabled` until confirmed |
| `O-21` | Inbound Zoho Mail polling cadence (15-min shared cron vs more frequent cron) | Hooks cleanly into existing 15-min `scheduled` cron with durable lease/cursor + manual `channel.poll_now`; `wrangler.jsonc` cron unchanged |
| `O-17` | Message/webhook retention, export and privacy erasure timelines | Bounded payload hashes stored in `crm_inbound_events`; no premature destructive retention sweep |
| `P-16` | Email open/click tracking off by default | Enforced off; no tracking pixels or link rewriters |
| `P-20` | "Conversations" area naming & `Asia/Kolkata` timezone confirmation | Preserved as configurable defaults |

---

## 10. Controlled Parallel Execution & Optional CI Certification Analysis (A-28)

Per **A-28**, comprehensive 18-project cross-browser UX certification matrices (`npm run qa:ux -- --crm` and `npm run qa:ux`) run at **P4** and **P6** rather than on every intermediate package. Analysis of the existing UX lab runner (`scripts/qa-ux.mjs`, `scripts/ux-lab/project-isolation.mjs`) identifies two safe efficiency options when full certification runs are scheduled:

1. **Controlled local parallelism (zero external cost):**
   - `runIsolatedProjects()` currently executes all 18 projects serially even though each child already spawns its own loopback HTTPS Wrangler server on an ephemeral `freePort()` with an isolated D1 directory under `<output>/projects/<project>/`.
   - Running a single upfront `npm run build` followed by bounded concurrency (`2–3` concurrent projects via a future `UX_CONCURRENCY` worker pool passing `--skip-build`) keeps strict per-project D1/port/fingerprint isolation while cutting local 18-project runtime by ~2–3× without risking `dist/` write races or OOM thrashing.
2. **Optional manual-only GitHub Actions CI certification (zero automatic spend):**
   - No `.github/workflows` currently exist in the repository; none are added or auto-triggered on push/PR so there is zero unintended paid CI consumption.
   - If Paul authorizes CI-assisted certification at P4 or P6, an explicit **`workflow_dispatch`-only** workflow can shard the 18 projects into 3 engine jobs (`chromium*`, `firefox*`, `webkit*`, 6 projects each) using `npm run qa:ux -- --skip-build --project=<engine>-*`, uploading only sanitized `summary.json`/`coverage.json` (never raw Playwright traces containing disposable session tokens, per `scripts/qa-ux.mjs:74-75`).
3. **Deterministic local package gate:**
   - `node scripts/verify-p3-communications.mjs` runs typecheck, all targeted P2 hardening + P3 communications + core CRM Vitest suites, pack validation, and certification selftests in one terminal command and emits a concise machine-readable JSON summary report (optionally saved via `--json-out`).

---

## 11. P3 Communications Hardening & Zoho G3 Gate (P4 Prerequisite)

- **Budget-safe ingest & webhook recovery:** `ingestChannelInboundEvents` tracks `budgetExhausted`, `unprocessedCount`, and `lastProcessedReceivedAt`. `pollCrmChannelAccount` never advances `poll_cursor` beyond durably processed events. `/api/crm/webhooks/:provider` returns HTTP `503` (`retryable: true`) whenever D1 budget prevents processing every event so Meta retries rather than losing events.
- **Exact duplicate vs DB error distinction:** Only `UNIQUE constraint failed: crm_inbound_events` increments `duplicatesSkipped`; `D1BudgetExhausted` and unrelated database errors propagate so genuine failures are never misclassified as duplicates.
- **Pre-dispatch revalidation:** Immediately before provider dispatch, `processCrmOutbox` revalidates current sender account active state, `crm.send:<channel>` capability, linked-record `ReadGate` access, canonical person active non-retired endpoint, effective non-broadening consent, explicit channel account state/config, account-scoped approved template, and window/`HUMAN_AGENT` eligibility.
- **Exact lease-generation fencing:** Outbox completion writes are fenced by `(status='sending', attempts, lease_until)` + `changes() = 1` before updating `crm_messages`/`crm_conversations`. Poll completion writes are fenced by `(rev, poll_lease_until)`.
- **SQL-enforced monotonicity:** Inbound receipt transitions enforce monotonic rank in SQL `WHERE status IN (...)`; conversation `window_expires_at` / `human_agent_window_expires_at` use `MAX(COALESCE(..., 0), ?)`.
- **Provider-account-scoped webhooks & routing:** Webhooks verify `X-Hub-Signature-256` against active accounts and strictly match every event's `receivingAccountId` (`phone_number_id` / `entry.id` / `recipient.id`); unmatched receiving accounts return `403 unmatched_receiving_account`. Deduplication, threading, and send-account resolution never fall back to an arbitrary account.
- **Command-fenced manual sweeps:** `channel.poll_now` and `outbox.process_now` commit `crmActorFence` + `crm_commands` idempotency row BEFORE executing via `postCommitExecute`.
- **Zoho Mail G3 production gate:** Official Zoho Mail REST API separates list (`/messages/view?start=&limit=`), full body (`/folders/{folderId}/messages/{id}/content`), and raw RFC 5322 headers (`/header?raw=true` -> `headerContent`). Production Zoho activation and dispatch/polling are explicitly blocked (`zoho_production_pending_G3`) outside `local-test` pending G3 verification (`O-20`, `O-21`).


