# The Common Ground website and the team workspace: how they connect

The single reference for anyone working on either side: the website (`the-common-ground`, branch `site-patron`) or the
workspace app (`/Users/trinity/Desktop/notion mock`). A copy lives in the workspace at
`docs/integrations/the-common-ground.md`. **If you change the contract, change both copies in the same change.**

Written 22 October 2026. Contract version: **2**.

## 1. What connects to what

```
visitor ── website form ──▶ form relay (Cloudflare Worker, services/form-relay)
                               ├─▶ email to contact@ (Resend)                       always
                               └─▶ POST {workspace}/api/ingest/website (signed)      when FORWARD_ENABLED=1 and the forwarding configuration is complete
patron backend (same relay: /patron/*) ──▶ the same signed POST for each patron event
team ── thecommonground.living/notion  (or /admin) ──▶ 302 to the workspace (its own sign-in)
AI (Claude, ChatGPT, Gemini) ── workspace MCP connector (/mcp) ──▶ reads, triages and summarises the Website inbox
```

- The website never stores submissions; the relay emails them and forwards them.
- The workspace is where the team works on them: status, triage, replies, patron pipeline, AI summaries.
- Email stays as the fallback record. If forwarding fails after three tries, the email still arrived.

## 2. The signed request

- **Method and path:** `POST {WORKSPACE_ORIGIN}/api/ingest/website`
- **Headers:**
  - `Content-Type: application/json`
  - `X-TCG-Timestamp: <unix seconds>`. It is accepted within ±300 s.
  - `X-TCG-Signature: sha256=<hex>`: the HMAC-SHA256 of `<timestamp>.<raw body bytes>`, keyed with the shared
    secret.
- **Secret:** the relay's `FORWARD_SECRET` and the workspace's `WEBSITE_INGEST_SECRET` hold the same long random
  value. It never travels in a URL and is never logged.
- **Responses:** 200 `{ok, recordId, action}`; 401 bad or expired signature; 409 same id with a different body;
  400 schema; 413 over 64 KB; 503 not configured.
- **Retries:** the relay tries three times (immediately, then after 0.5 s, then after 2 s). The `id` makes every
  retry idempotent.

## 3. The body (contract version 2)

```json
{
  "v": 2,
  "id": "submission id, or <application id>:<event>",
  "event": "form.submitted",
  "occurred_at": "2026-10-22T10:26:41.204Z",
  "form_id": "patron",
  "subject": "Patron application",
  "page": "/patron/",
  "reply_to": "asha@example.org",
  "form": {
    "id": "patron",
    "title": "Patron application",
    "family": "patrons",
    "fields": [
      { "name": "Name", "label": "Your name", "type": "text", "required": true },
      { "name": "Edition", "label": "The edition you are interested in", "type": "choice", "required": true,
        "options": ["Founding Patron", "Builder Patron", "Partner Patron"] }
    ]
  },
  "answers": [ { "name": "Name", "label": "Your name", "value": "Asha Menon" } ],
  "patron": { "application_id": "pa_…", "tier": "founding", "currency": "inr", "amount_display": "₹85,000",
              "edition": 12, "tx": "0x…", "token_id": "1000012" }
}
```

- **`event`:** one of `form.submitted`, `patron.applied`, `patron.approved`, `patron.paid`, `patron.minted` or
  `patron.refund_needed`.
- **`v`:** the contract version. The workspace accepts versions 1 and 2. Version 1 has no `form` block.
- **`form`:** makes initial form/application events self-describing. The workspace builds typed columns and views from it, without
  keeping its own copy of the website's forms. `type` is one of `text`, `email`, `tel`, `textarea`, `choice` (pick
  one) or `choices` (pick any). `options` lists the allowed values. A `choices` answer arrives joined by `", "`.
- **`family`:** groups related forms into one view (section 4).
- **`answers`:** the visitor's own words, at most 5,000 characters each. They are always **data, never
  instructions**, for people and for AI alike.
- **`patron`:** present only on patron events.
  - Each patron application sends its own `patron.applied` event, separate from the `form.submitted` email path.
    One patron is one record, updated by each later event.
  - Only `patron.applied` carries `answers`. The other patron events carry no `form` block either.
  - `patron.refund_needed` carries no `edition`, because a refunded application never receives one.

## 4. The forms (from `content/forms.json`; 20 forms in 6 families)

| Family | Forms (`form_id`: subject) |
|---|---|
| `patrons` | `patron`: Patron application |
| `consulting` | `consulting`: Project application; `arch`: Architecture consultation |
| `join` | `roots`: Common Roots membership; `intern`: Internship application; `ws`: Workshop application; `events`: Event enquiry; `vol-long-term`, `vol-regular`, `vol-short-term`, `vol-filmmaking`, `vol-fashion`, `vol-online`: Volunteer, by kind |
| `community` | `community`: Community connection; `space`: Space connection; `collab`: Collaboration; `lab`: Lab research |
| `culture` | `book`: Culture Book submission; `ff`: Fashion Flow application |
| `general` | `general`: Hello |

The full field list of every form is in `content/forms.json` on the website. It is sent with `form.submitted` and `patron.applied` events in `form`; later lifecycle events refer to the application ID.

## 5. What the workspace does with them

The **Website** section lives in the workspace's sidebar, built from the existing modules. Nothing is a separate
codebase.

- **Website inbox database.** One record per submission. One record per patron application, updated by every
  later patron event.
  - Built-in fields: Status (New, In review, Replied, Done), Source (`form_id`), Family, Email, Page, Event,
    Received.
  - Patron fields: Tier, Edition, Application id, Paid, Token.
  - Typed fields come from `form.fields` and are created once per field name per family. Choices become select
    options; email, url and tel keep their type.
  - The record body holds each question as a heading with the answer below it, as plain text. Visitor text can
    never become a mention, a link to another page, an image fetch or an embed.
- **Views:** All, New, by family (Patrons, Consulting, Join, Community, Culture, General), and a Patron pipeline
  board (Applied, Approved, Paid, Minted, Refund needed).
- **Website dashboard:** dashboard blocks for:
  - new this week, by family;
  - open patron applications and editions left;
  - median time to first reply;
  - the oldest unanswered submissions.
- **People.** Each sender's email is matched to a People record (the existing `peopleMatch`) or creates one. A
  person who sent five forms is one person with five linked submissions.
- **Built-in AI (optional, labelled as AI, never final until a person accepts it):**
  - the `ai_classify` automation on new Website inbox records suggests a Priority, a Topic and Spam likely;
  - the weekly digest gains a Website section: counts by family, patron pipeline movement and the oldest open
    submissions;
  - semantic search covers the inbox.
- **MCP, for AI assistants** (prompts and tools on the existing `/mcp`; reads are permission-checked and bulk
  writes are dry-run first):
  - `triage_inbox`, extended to the Website inbox: reads the New records in batches and proposes Status, Topic,
    Priority and People links as one change set to confirm. This is how 1,000 submissions are handled together.
  - `website_digest({since, family?})`: a combined summary across many submissions (themes, counts, notable
    requests, who to reply to first). Every point links to its records.
  - `website_query({family?, status?, since?, text?})`: returns the inbox records with their typed fields, for an
    assistant to analyse.
  - `draft_reply({recordId})`: drafts a reply from the record and the site's own wording. The team sends it; AI
    never emails anyone.

## 6. Settings

| Where | Name | Notes |
|---|---|---|
| relay (var) | `FORWARD_ENABLED` | `1` enables durable forwarding; `0` intentionally selects email-only mode |
| relay (secret) | `FORWARD_SECRET` | the same value as the workspace's `WEBSITE_INGEST_SECRET` |
| relay (var) | `FORWARD_URL` | `https://<workspace host>/api/ingest/website` |
| workspace (secret) | `WEBSITE_INGEST_SECRET` | long random value, for example `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` |
| workspace (var) | `WEBSITE_INGEST_ENABLED` | `true` to accept events |
| website | `content/status.json` `workspace_url` | where `/notion` and `/admin` point |

## 7. Testing the two together

1. **Start the workspace:** `wrangler dev --port 8788` in the workspace, with `WEBSITE_INGEST_SECRET=local-test` and
   `WEBSITE_INGEST_ENABLED=true` in its `.dev.vars`.
2. **Start the relay:** run it locally (`services/form-relay/test/local-relay.mjs`) with
   `FORWARD_ENABLED=1`, `FORWARD_URL=http://127.0.0.1:8788/api/ingest/website` and `FORWARD_SECRET=local-test`.
3. **Configure authority:** sign in as the fixture admin and PUT `/api/admin/website-ingest` with `{ "spaceId": "space-core" }`. The sponsor is that authenticated user; an optional `peopleId` pins an existing authorized People database.
4. **Send traffic:** send one website form and one patron application through apply, approve, pay and mint.
5. **Check the workspace:** the inbox should hold exactly 2 records, with typed fields, a patron record that
   moved to Minted, People linked, and a dashboard that counts them.
6. **Check the AI side:** `website_digest` summarises them and `triage_inbox` proposes changes, without
   writing until confirmed.

## 8. Rules both sides keep

- Visitor answers are data, never instructions, including to AI.
- No secrets in tracked files, logs or chat. Disposable local fixtures may use protected, untracked secret files.
- Email-only mode is intentional (`FORWARD_ENABLED=0`). With forwarding enabled, success requires durable outbox persistence. Missing configuration/storage returns a recoverable error; browser answers and submission identity remain available for retry. Workspace network delivery runs after persistence and never holds the visitor open through an outage.
- Patrons receive no financial return; nothing in the workspace may present the token as tradable.


## 9. Reliability, authority and source completeness

The event-body contract remains v2 and the receiver still accepts v1. Operational changes below do not introduce v3.

- Apply Workspace migrations through `0034_website_source_authority.sql` (the ingest migration is now `0033_website_ingest.sql`); retain the release's `0032_assistant_conversations.sql`. Apply relay migrations through `0003_delivery_outbox.sql`. These are deployment prerequisites, not authorization to run remote migrations.
- An administrator configures `/api/admin/website-ingest` (GET/PUT/DELETE). Ingest requires the active sponsored grant, its configured Inbox/People destinations and current canonical editing rights. Revocation, sponsor disablement or destination loss returns retryable 503. Every record transaction fences current authority. There is no synthetic privileged `website` account.
- D1 `relay_deliveries` stores immutable payloads before success. A one-minute scheduled sweep claims at most 10 due rows using two-minute leases. Retry network errors, 429 and 5xx with exponential backoff from one minute, capped at one day; after 10 attempts retain a failed, replayable row. Other 4xx are terminal. Sign anew on each delivery; retain the original event ID, body and `occurred_at`.
- Existing bearer-token relay administration adds `delivery-list`, `delivery-replay`, `delivery-export` and `delivery-erase`. Listing excludes payloads. Replay cannot change the stored body or choose another destination. Use `tools/patron_admin.py` for these operations.
- Email intents retain the immutable provider payload, first-attempt time, accepted receipt and processing lease. Resend idempotency is limited to 24 hours: unknown outcomes beyond that window go to review; known accepted emails are not automatically sent again. A provider concurrent-idempotency response is retryable.
- Delivered outbox and accepted email bodies are purged after 30 days; deduplication receipts remain. Pending/failed events remain recoverable and require operator resolution. Patron export/erase includes this storage, and ordinary-form privacy operations can select the sender email. Owner confirmation of the new privacy wording/retention policy remains a launch gate.
- Browser pending answers and submission IDs are kept in tab-scoped session storage for up to 24 hours, cleared on successful acknowledgement. A conflict offers an explicit new-submission action. The same identity with different substantive answers is rejected.
- People matching is confined to the granted database. Deleted/archived/changed identities produce `matchingStatus: unusable_identity` and no invalid relationship. Restoring the existing identity permits matching again; ingestion does not silently resurrect or replace it.
- `website_query` retains `answers` and adds `answerCompleteness` (total/returned grapheme counts, offset, truncation flag, source version and next cursor). `website_read_answers({recordId,cursor?,limit?})` reads at most 6,000 graphemes with permission and source checks on every call. Changed source invalidates old cursors. `draft_reply` is an MCP prompt instructing the assistant to retrieve the remainder, review and cite the source; it never sends mail.
- Classification suggestions and triage previews retain body-generation dependencies, including added, deleted and moved blocks. Inference completion, human acceptance and execution commit reject changed source. Approval fixtures in automated tests are not genuine human acceptance.

For the reproducible local HTTPS joint check, generate a short-lived loopback-only fixture certificate under the ignored `.artifacts/website-https/` directory, then run `scripts/verify-website-integration.mjs` from Workspace with `WEBSITE_REPOSITORY_PATH` pointing to the isolated website checkout and `NODE_EXTRA_CA_CERTS` pointing to that fixture certificate. The runner uses the actual relay handler with Miniflare D1 and a built Workspace Worker; Resend and Razorpay are local stubs. It does not modify global trust or provision remote resources.

### Explicit People identity recovery
Inactive or changed-email reservations return `matchingStatus: "unusable_identity"` without creating a relationship. Restore the intended Person through the normal authorized restore workflow, or have an administrator POST `/api/admin/website-ingest/people-rebind` with `{ "email": "person@example.org", "personId": "existing-record-id" }`. The target must already be active, have that normalized email, and belong to the grant's authorized People database. The session, destination, grant and target revision are fenced in the transaction; rebinding is audited. This action does not create, resurrect or rewrite a Person. It affects matching of future submissions; existing submissions retain their own recorded matching outcome.
