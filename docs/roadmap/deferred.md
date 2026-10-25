# Deferred: do not build without a new owner request

| Item | Why deferred |
|---|---|
| Character-level co-editing (CRDT/Yjs) | Block- and field-level merging plus presence suits 7 people; a CRDT adds Durable Object memory and complexity across sync, history and undo |
| Full-text search inside PDFs and attachments | Parsing in Workers risks CPU limits and bloats FTS; large documents live in Google Drive |
| Voice chat with the assistant, inline AI autocomplete | Cost and latency; autocomplete spends tokens on every pause; the assistant panel covers the need |
| Pen and freehand drawing on canvas | Heavy input engineering, low operational value |
| On-device database encryption | Keys must live in browser memory; breaks IndexedDB indexing and local search; access revocation already evicts data |
| Hosted "Sign in with ChatGPT" on the server | Needs OpenAI approval (`OPENAI_CHATGPT_HOSTED_APPROVAL`); the local companion covers it |
| Video trimming and transcoding | Media engineering with low return |
| Inventory, orders, fulfilment for Common Cupboard | Needs an owner-designed workflow and ledger; fields alone do not imply it |
| Bank feeds, reconciliation, exchange rates, formal accounting | Separate integrations with legal and financial implications |
| Event check-in, attendance proof, capacity enforcement, consent records | Need owner-defined rules first (see 8.7) |
| Sending email replies from the Website inbox | Separate authorized integration; drafts only today |
| External publishing (social, CMS, analytics) | Needs destination mappings and receipts |
| Milestones in project health | Needs an owner definition of a milestone |
| Snoozing and acknowledging attention items | Needs a server table and rules; v1 is derived state only |
| SMS and WhatsApp notifications | Cost and compliance; email and push first |
| Direct browser-to-R2 uploads | Current chunk protocol works offline and resumes; revisit at higher volume |
| Files larger than 20 MB | Finalize concatenates the chunks in Worker memory; larger files need a streaming or R2 multipart design (5 MiB minimum parts) |
| Email-to-inbox (forward an email → record) | Needs the owner's domain on Cloudflare Email Routing (unverified), an Email Worker handler, sender allowlisting and attachment limits. Plan it after Phase 10 using the Website-ingest pattern (signed, scoped grant, `applyChanges`) |
| Webhooks out (to Slack, Zapier and others) | Outbound calls to user-configured URLs break the exact-host egress rule; needs an admin-approved destination allowlist, signing, retries and an outbox. Design separately |
| Webhooks in (generic) | Each source needs its own signed, scoped ingest like `worker/websiteIngest.ts`; build per integration, not as a generic endpoint |
