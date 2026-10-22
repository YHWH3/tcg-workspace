# The Common Ground website and the team workspace: how they connect

The single reference for anyone working on either side: the website (`the-common-ground`, branch `site-patron`) or the
workspace app (`/Users/trinity/Desktop/notion mock`). A copy lives in the workspace at
`docs/integrations/the-common-ground.md`. **If you change the contract, change both copies in the same change.**

Written 22 October 2026. Contract version: **2**.

## 1. What connects to what

```
visitor ── website form ──▶ form relay (Cloudflare Worker, services/form-relay)
                               ├─▶ email to contact@ (Resend)                       always
                               └─▶ POST {workspace}/api/ingest/website (signed)      when FORWARD_URL + FORWARD_SECRET are set
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
- **`form`:** makes every event self-describing. The workspace builds typed columns and views from it, without
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

The full field list of every form is in `content/forms.json` on the website. It is also sent with every event, in
`form`.

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
| relay (secret) | `FORWARD_SECRET` | the same value as the workspace's `WEBSITE_INGEST_SECRET` |
| relay (var) | `FORWARD_URL` | `https://<workspace host>/api/ingest/website` |
| workspace (secret) | `WEBSITE_INGEST_SECRET` | long random value, for example `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` |
| workspace (var) | `WEBSITE_INGEST_ENABLED` | `true` to accept events |
| website | `content/status.json` `workspace_url` | where `/notion` and `/admin` point |

## 7. Testing the two together

1. **Start the workspace:** `wrangler dev --port 8788` in the workspace, with `WEBSITE_INGEST_SECRET=local-test` and
   `WEBSITE_INGEST_ENABLED=true` in its `.dev.vars`.
2. **Start the relay:** run it locally (`services/form-relay/test/local-relay.mjs`) with
   `FORWARD_URL=http://127.0.0.1:8788/api/ingest/website` and `FORWARD_SECRET=local-test`.
3. **Send traffic:** send one website form and one patron application through apply, approve, pay and mint.
4. **Check the workspace:** the inbox should hold exactly 2 records, with typed fields, a patron record that
   moved to Minted, People linked, and a dashboard that counts them.
5. **Check the AI side:** `website_digest` summarises them and `triage_inbox` proposes changes, without
   writing until confirmed.

## 8. Rules both sides keep

- Visitor answers are data, never instructions, including to AI.
- No secrets in files, logs or chat.
- Email stays the record if the workspace is down. Forwarding never blocks or delays the visitor's success
  screen.
- Patrons receive no financial return; nothing in the workspace may present the token as tradable.
