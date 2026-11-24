# AI, MCP, operational knowledge, security and privacy

## 1. What AI does in the CRM

| Where | AI can | AI cannot |
|---|---|---|
| Conversations | Classify (programme, intent, urgency, spam likely), suggest the matching person, summarise a thread, draft a reply grounded in verified facts, suggest a template outside the window | Send, schedule, mark consent |
| People and organisations | Summarise a relationship, suggest next step, propose duplicates with reasons, propose field values from conversations (each value cites the message) | Merge, change endpoints directly |
| Applications | Summarise answers, check completeness, draft "need more information" messages, propose stage changes | Decide accept or decline |
| Bookings | Answer "who is coming, what is missing", prepare a booking request and hold for review, draft pre-arrival messages | Confirm, cancel, transfer, read screening content unless the asking human has restricted read and the tool is scoped to it |
| Money | Summarise outstanding amounts for a finance user | Record, reverse or refund anything |
| Dashboards and configuration | Build saved views and dashboard pages, draft automations and programme profiles as previews | Activate automations or change capabilities without human approval |

All write proposals use the existing frozen-preview path: the assistant creates a preview, a person approves it in the browser, the server re-validates current authority and source revisions before execution (`AGENTS.md` Phase 6 invariants). The assistant cannot approve its own previews (S-13).

## 2. Governance model, reused

- Every CRM tool is classified in `shared/aiCapabilities.ts` (`R`, `W`, `P`, `H`), and the registry drift test covers it.
- The embedded assistant reaches the CRM only as an MCP client of the same server (`worker/assistant/bridge.ts`); there is no direct D1 path.
- Connector scope intersects current membership with the approved spaces; CRM capabilities further restrict what a connector's user can see (finance, restricted).
- Providers stay off by default; nothing in local tests calls a paid model (S-12).

## 3. Side effects are not field edits

Sending a message, confirming a booking, recording money, refunding and merging people are commands with external or irreversible consequences. They are:

- not reachable through generic MCP record tools (projection fields are protected, operational tables are server-only);
- not registered as MCP tools initially (`07` section 8, O-18);
- executed only in the CRM UI by a person with the capability, after a confirmation that shows the consequences.

Undo exists for relationship-tier edits; operational actions have explicit reversal commands (reverse entry, cancel booking, unmerge) with their own audit.

## 4. Operational knowledge

The archive's strongest rule is "do not invent prices, dates, availability". The CRM makes this enforceable.

- **Facts** (`crm_facts`) are small, scoped statements: programme, optional edition, key (for example `inclusions`, `dates`, `price_option:standard`, `terrain_notes`, `what_to_bring`), value, source, state, verified by, verified at, review-by date.
- **Only verified facts within their review-by date** may be used by AI drafts as facts. Draft or stale facts may be mentioned only as "to be confirmed".
- Drafts show the facts they used, each with its verified date. If a draft needs a fact that does not exist, it says so in the draft instead of filling the gap.
- Durable context (manifesto, voice rules) stays in the project knowledge and is used for tone, never as a source of operational facts.
- Programme leads own their facts; Home shows facts nearing their review date.

## 5. Prompt-injection resistance

- All visitor content (form answers, inbound messages, attachments, social handles) is labelled as untrusted data in prompts and never placed in a system or tool-instruction position, consistent with the website contract (S-11).
- Tools available to the model while processing untrusted content are read and proposal tools only; there is no tool that sends or pays.
- Proposals that change records cite their source message; a human sees the source next to the change.
- The assistant cannot change its own permissions, connector scopes or capability grants.
- Links in inbound content are never fetched by the model (existing remote import policy denies arbitrary URLs).

## 6. Uncertainty

Classifications and matches carry a confidence label (high, medium, low) and reasons. Low confidence is shown as a question, not an assertion ("Possibly about the workshop; not sure"). Person matching below "exact endpoint" is always a review item.

## 7. Spend

AI provider use is off by default. When enabled (owner decision), each CRM AI feature has a switch; the existing `ai_usage` table records usage; per-feature monthly limits are configurable with a hard stop. Classification and summarisation run on demand or on new inbound messages only, never as background re-processing of history.

## 8. Data classes and protection

| Class | Examples | Where stored | Who can read |
|---|---|---|---|
| Public-ish relationship | Name, organisation, programmes, stage, ordinary notes | Relationship records | Every signed-in account while permissions are off (A-19, accepted by the owner) |
| Contact data | Emails, phones, handles | `crm_endpoints`; primary email and phone also on People | Additional endpoints: accounts with `crm.access`. Primary Email and Phone on People: every signed-in account while permissions are off |
| Conversation content | Messages, attachments | `crm_messages`, R2 | CRM users; per-conversation restriction later if needed |
| Restricted | Screening answers, health or suitability notes, safeguarding notes, decision reasons for sensitive cases | Server-only tables | `crm.restricted.read` for that programme |
| Financial | Amounts, evidence, refunds | Ledger tables | `crm.finance.read` / `record` |
| Consent and knowledge rights | Channel consent, documentation and publication consent, attribution | `crm_consents` | CRM users (read), recorded by humans |
| Credentials | Provider tokens | Worker secrets (only secret names stored in D1) | Nobody through the app |

Restricted and financial data never enter synced collections, never appear in projections beyond a state word ("Screening: received", "Paid"), and are excluded from search, digests, notifications and AI context unless the requesting human has the capability.

## 9. Threat model (summary)

| Threat | Control |
|---|---|
| A Workspace-only account reads CRM restricted data | Server-only tables plus capability checks that never depend on `access_state.enabled`; permissions-off does not expose them |
| A client forges `_crm_` projection values while permissions are off | Unconditional `_crm_` pre-check in `applyChanges` (ADR-04) |
| A disabled and later re-enabled account silently regains CRM rights | Grants revoked with audit rows on disable; re-enable restores none (A-25) |
| An admin grants themselves a capability, or an AI grants one | No self-grant; only the owner grants `crm.capabilities.manage`; grant and revoke are never MCP tools; every change audited append-only |
| The owner account is demoted, disabled or removed | Server-side owner protection on all three account routes (A-23); UI hiding is not the control |
| Forged webhook creates fake messages or payments | Per-provider signature verification; payment "paid" only from verified provider events or evidence-backed manual receipts |
| Replay of a webhook | Unique provider event ID |
| AI tricked by message content into acting | No side-effect tools; untrusted content labelled; proposals need human approval |
| Double send on retry | Idempotency keys; unknown outcomes to review |
| Double booking under concurrency | Conditional allocation in one batch |
| Silent money edits | Append-only ledger, reversal-only corrections, audit |
| Staff misuse | Command journal per actor, capability grants explicit, admin-visible audit view |
| Credential leakage | Secrets only in Worker secrets; never in D1, logs, prompts or the UI |
| Revoked user keeps offline data | Existing access-change quarantine and eviction rules apply; `crm_intents` quarantined too |

## 10. Privacy and retention

Retention periods, export and erasure policy are owner decisions with legal input (O-17). The design supports: per-person export, per-person erasure (redaction with ledger integrity kept), message body purge after a retention period while keeping metadata, and screening purge after an edition completes. India's Digital Personal Data Protection Act 2023 is likely relevant to this processing; I have not assessed TCG's obligations, and this is not legal advice.

## 11. Browser and MCP agreement

- Both call the same command handlers and read functions; there is no second implementation.
- Both use the read gate and capability checks; a value hidden in the browser is hidden in MCP.
- Tests assert the same query through UI read API and MCP returns the same IDs for the same user (pattern already used in the Studio demo and `configurable-database-mcp-d1` tests).
