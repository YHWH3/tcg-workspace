# Embedded AI, universal MCP and provider integrations

Branch `feature/unified-ai-mcp`, based on the 1.0.0 release candidate `5b07263`. This branch is for review only. Nothing in it is deployed, migrated remotely or activated.

## 1. One capability system, three experiences

```
              ┌──────────────── shared/aiCapabilities.ts (classification of every tool)
              │                 shared/aiActions.ts      (contextual action catalog)
              ▼
 createWorkspaceServer (worker/mcp.ts) ── the ONLY implementation of workspace actions
   ▲ HTTP Streamable MCP + OAuth            ▲ InMemoryTransport (in process)
   │ (external hosts: Claude, ChatGPT,      │ worker/assistant/bridge.ts
   │  TCG Workspace Companion, …)           │ embedded assistant runtime
```

- **External MCP.** Unchanged OAuth 2.1, PKCE and DCR, space-scoped connector grants, the read gate, frozen previews and browser approval.
- **Embedded assistant.** A real MCP `Client` (`@modelcontextprotocol/client` 2.3.1) is connected over an in-memory transport to a per-step `createWorkspaceServer`. That server carries the session user's identity, a fresh read gate and `ctx.assistant`. There is no self-HTTP loop, no privileged D1 shortcut and no second implementation of any action.
- **Contextual AI.** Module menus and the editor selection menu send `actionId` plus explicit `ContextRef`s to the same runtime. The same catalog is registered as MCP prompts named `action_<id>` for external hosts.

### Embedded write policy (`ctx.assistant`)

- Every reg()-wrapped write is planned and returned as a frozen preview (`humanApprovalRequired`). A plan that captures no operations fails closed with `assistant_write_produced_no_plan` and never falls through to execution.
- Human-only capabilities are refused before their handlers run: `execute_preview`, `request_approval`, `decide_approval`, `undo_change`, `publish_page` and `share_moodboard`. A `previewId` argument is refused too.
- The assistant UI's approval card calls the existing session-authenticated `POST /api/ai/previews/:id/decision` and `/execute` endpoints. The model can never approve its own proposal.

### Dynamic discovery

`hasWritableSpace` (worker/capability.ts) returns false when the caller can write no space: a guest, viewer-only access, or a connector scope without edit rights. In that case the **embedded assistant** offers the model only read tools (bridge.ts), and `GET /api/assistant/capabilities` marks writes unavailable.

**External MCP keeps the certified Phase 5 contract:** the full tool list is advertised, and each handler returns its own authorization result. Two reasons:

- MCP hosts cache `tools/list` per connection, so hiding writes would strand a grant upgraded mid-session. `verify-phase5-mcp` exercises exactly that viewer → editor flow.
- `disable()` would also turn domain refusals into protocol errors.

Hiding a tool is never authorization; every handler revalidates.

### Universal MCP additions (worker/mcpAssistantTools.ts)

- `list_automations` (read): plain-language rules plus recent run status and error.
- Resources: `workspace://overview`, `workspace://capabilities`, and the templates `workspace://pages/{id}`, `workspace://records/{id}`, `workspace://databases/{id}` and `workspace://moodboards/{id}`. Each resource delegates to the registered tool handler, so authorization is identical.
- Prompts: the 7 workflows, the 3 planning prompts and 31 `action_*` contextual prompts.

## 2. Runtime: one bounded step per request

Workers Free gives about 50 D1 queries, 50 subrequests and 10 ms of CPU per invocation, and the application budget is 45 binding calls. The runtime (`worker/assistant/runtime.ts`) therefore does one step per HTTP request, streamed over SSE:

| Request | Work |
|---|---|
| `POST /conversations/:id/messages` | Validate, then resolve up to 3 explicit context refs through MCP read tools (read gate). Store the user message with source IDs and create the run. If no context was attached, run the first model segment. |
| `POST /runs/:id/continue {step}` | Compare-and-set claim at exactly `step` from the session that started the run. Then either dispatch one pending tool call, or run one model segment. |

Controls:

- Replayed or duplicate continues fail with `run_conflict`.
- A unique partial index allows one active run per conversation.
- Abandoned runs expire after 2 minutes.
- There are at most 8 steps and 4 tool calls per segment. Tool payloads are capped at 6,000 characters, context at 12,000 per ref and history at 60,000.
- Session and cancellation are rechecked after every model segment and tool call.
- Tool results and context are wrapped as `trust="untrusted"`.
- Citations are accepted only for IDs the conversation actually read and the user can still read.

Tests (`tests/assistant-runtime-d1.test.ts`) run every request under `withD1Budget(env,45)`.

## 3. Conversation storage (migration 0032, additive)

These are server-only tables: `assistant_conversations`, `assistant_messages`, `assistant_runs`, `assistant_credentials` and `assistant_settings`. They are never synced collections.

- **Retention:** 7, 30 (the default) or 90 days. The existing scheduler retention phase purges in bounded batches. Users can delete one conversation or all of them.
- **Revalidation:** each message stores the record IDs it used. On reopen, and before history is sent to a model, messages whose sources are no longer readable are redacted. This covers revocation, space moves, guests and account switches.
- **What is not stored:** credentials or provider metadata in messages.

## 4. Providers

Status, credentials, model discovery, streaming, tool-call translation and errors are separated per provider (`worker/assistant/providers.ts`).

| Mode | Provider | Status in this branch |
|---|---|---|
| E — No AI | none | Default. The workspace, search, deterministic digest, MCP server and human approval all keep working. |
| D — Workers AI | `workers-ai` | Implemented; disabled by default. Needs `AI_PROVIDER=workers-ai`, `AI_CHAT_MODEL` and `AI_DAILY_UNITS`. Tested with a fake binding only. Uses the operator budget through `reserveAi`. |
| C — BYOK | `openai` (Responses API), `anthropic` (Messages API) | Implemented; disabled by default. Needs `AI_BYOK_PROVIDERS` and the secret `AI_CREDENTIAL_KEY`. Keys are AES-GCM encrypted with AAD `user:provider` and are never returned. Contract-tested with recorded-shape streams. **Real-account acceptance requires the user's own key — NOT RUN.** |
| A — ChatGPT plan, hosted | `chatgpt-hosted` | **Requires OpenAI approval.** OpenAI requires paid or remotely hosted apps to apply. It reports `requires_provider_approval`, and no hosted token flow is implemented. |
| A — ChatGPT plan, local | `companion/` (TCG Workspace Companion) | Implemented as a local CLI on the user's machine. Sign in with ChatGPT uses `dynamic_agent_client`, a host ID, a 127.0.0.1 callback, PKCE, nonce and an ID-token check against JWKS. Calls go to Responses with `store:false` and `stream:true`. Workspace tools are reached through ordinary scoped MCP OAuth. **Real-account acceptance recorded on October 21 — see §7.** |
| B — Subscription MCP hosts | Claude, ChatGPT and others | Supported through `/mcp` OAuth under each host's own subscription and connector rules. Claude subscriptions are not used for embedded inference; Claude models are available embedded only through the Anthropic API (BYOK). |
| Test | `simulated` | Only when `WORKSPACE_ENV === 'local-test'`. Deterministic, and never labelled as real. |

Policy:

- No provider falls back to another provider or billing path on failure, plan exhaustion or disconnection.
- Egress goes only to the exact host constants (`api.openai.com`, `api.anthropic.com`), with `redirect:'error'`.
- The UI names the receiving host before context is sent.

**Extension of the Phase 6 egress invariant.** "No workspace text in external requests" still holds for every server feature. The single explicit exception is embedded inference on a provider the user selected, and it is limited to:

- the conversation history, and
- the context the user attached.

Images and files are never uploaded implicitly; no provider in this branch claims image input.

## 5. Module → capability map

| Module | MCP tools (read / write→preview / proposal) | Resources and prompts | Embedded contextual actions |
|---|---|---|---|
| Pages and editor | get_page; create_page, edit_page, find_or_create_page | workspace://pages/{id}; action_page_* | Selection: rewrite, summarize, expand, shorten, tone, translate, extract actions, ask. Page: summarize, outline, structure notes. |
| Tasks and projects | get_task, get_record, neighbors; create_tasks, update_tasks, add_dependency, set_parent, create_project, convert_idea_to_project | workspace://records/{id}; project_review, action_task_* | Explain and dependencies, breakdown, progress and blockers, project plan |
| Databases, properties, views | query_records, get_board; create/update_records, add/update/remove field/stage/view, link/unlink | workspace://databases/{id} | Analyze records, categories and views, duplicates |
| Dashboards | dashboard_snapshot, operating_review_context | weekly_operating_review | Explain dashboard, operating review |
| Moodboards | get_moodboard; add/update_mood_items, connect_items, layout_moodboard, add_frame… | workspace://moodboards/{id} | Visual direction (text metadata only), organize |
| Files | list_attachments | — | via notes actions |
| Comments | list_comments; add_comment | — | — |
| Approvals | list_approvals; request/decide_approval (human-only) | — | — |
| People | find_collaborators | who_can_help | Who can help |
| Forms and Inbox | query_records, get_record; propose_suggestion (proposal) | triage_inbox | Classify and destination, draft reply |
| Automations | list_automations | action_automation_explain | Explain automations (read-only) |
| Search | search, fetch, workspace_overview | workspace://overview | Ask the workspace |
| History and changesets | get_record_history, recent_activity, activity_for, list/get_change; restore_record_fields; undo_change (human-only) | — | — |
| Workflows | propose_workflow (proposal); execute_preview (human-only) | 7 workflow prompts | Meeting → actions, field notes, case study |

## 6. Verification

- `tests/assistant-registry.test.ts` checks that the registry equals the registered tools in both directions, that `read` matches `readOnlyHint`, that unknown tools are denied, that discovery hides writes, and that resources and prompts are registered.
- `tests/assistant-runtime-d1.test.ts` runs on actual D1. It covers:
  - sourced answers, and injected or destructive requests turned into previews;
  - human-only refusal, replay and cross-session conflicts, and session revocation mid-run;
  - account isolation, simultaneous conversations, plan exhaustion and interruption with no other fetch;
  - unavailable providers with no fallback, retention and delete-all;
  - cross-space context denial, redaction on reopen, and capability hiding;
  - BYOK AAD binding, a representative write sweep, and the 45-call budget.
- `tests/assistant-providers.test.ts` contains Responses and Anthropic stream contract tests, the plan-route forbidden fields, error mapping, egress host and redirect checks, and default-off eligibility.
- `tests/companion-*.test.ts` covers the local SIWC flow, callback, Host and Origin defences, ID-token validation, refresh races, credential files and the tool loop.
- `scripts/verify-assistant.mjs` (`npm run certify:ai`) drives the built Worker, D1 and the browser UI with the simulated provider on desktop and mobile.

**Simulated results are not real-provider acceptance.**

## 7. External acceptance with real hosts (2026-10-21)

Run through the Aside browser with the owner's approval. Setup:

- A disposable local fixture with synthetic data, permissions **enabled**, and two spaces: Common Lab and Private (holding the `VAULT_CANARY` page).
- A temporary Cloudflare quick tunnel to that fixture. The fixture used `dev.upstream_protocol: https` so the Worker saw the public HTTPS origin, as on Cloudflare.
- The owner typed the fixture password on the tunnel consent pages.
- Everything was torn down afterwards: connectors removed, the companion signed out with its session revoked, test secrets deleted, and the tunnel and fixture stopped.
- Production was not touched.

| Host / path | Result |
|---|---|
| **Claude.ai custom connector** | PASS (details below). |
| **ChatGPT custom MCP server (dev-mode plugin)** | PASS: metadata discovery and DCR; consent page names `chatgpt.com`; Common Lab-only grant; sourced read; `VAULT_CANARY` empty; pending proposal with review URL and no execution; injection refused; 401 after revocation. |
| **ChatGPT plan, local companion (Sign in with ChatGPT)** | PASS (details below), after one fix. |
| Bring-your-own-key OpenAI or Anthropic, Workers AI chat | NOT RUN: needs the owner's own API keys or an operator decision. |
| Physical devices, VoiceOver/TalkBack/NVDA, native 400% zoom | NOT RUN: needs hardware or human testers. |

**Claude.ai custom connector:**
- Discovered OAuth and DCR on its own, and used PKCE S256 with the exact `resource`.
- The consent page named `claude.ai` and warned that the client name is unverified.
- Space selection was granted for Common Lab only.
- Tool discovery listed every tool plus the `workspace://overview` and `workspace://capabilities` resources.
- A sourced read of the Common Lab page succeeded. Searching `VAULT_CANARY` returned an empty result.
- `propose_workflow` created a pending preview, and nothing was written.
- Claude identified and refused the prompt injection planted in the meeting note.
- A session-authenticated human approved; `execute_preview` completed with a changeset, and a second call returned `replayed:true` with the same changeset.
- The created page cites its source.
- After revocation, the next call returned 401.
- Host limitation: claude.ai chat does not enumerate MCP prompts.

**ChatGPT plan through the local companion:**
- The authorize request matched the spec: `dynamic_agent_client`, host ID, `agent_name_hint`, `127.0.0.1:1455/auth/callback`, plan scopes and `resource`.
- Consent covered identity plus plan usage. The ID token validated, and `chatgpt.tokens.use.direct` was granted.
- Credential files are mode 0600 and no tokens appear in logs. A replayed state was rejected (`invalid_state`).
- Account model discovery listed 7 models.
- The companion fails closed when the Workspace issuer does not match its origin.
- Workspace OAuth was scoped to Common Lab.
- GPT-6.1-Sol on the plan used namespaced function tools. It returned a sourced read, an empty `VAULT_CANARY` result, and a pending proposal whose review URL was printed. The injection was refused.
- Logout revoked the session.

**Defects found by real hosts and fixed:**
- **Companion: tool calls dropped with `store:false`.** On the real account, `response.completed.output` was empty with `store:false`; the items arrive only in `response.output_item.done`. The companion read the completed output, so every function call was silently dropped. It now collects the streamed items, with a regression test in `tests/companion-responses.test.ts`. The Worker adapter already read the streamed items.

**Observations (not fixed):**
- **Preview impact counts — corrected in the PR #13 review round.** The full frozen plan still includes activity rows. Both review surfaces now distinguish content operations, activity/audit operations and the unchanged total. Older stored previews explicitly label their aggregate as total operations.
- **Revocation error wording.** After revocation, Claude shows its own generic "didn't complete authentication" text. The server correctly returns 401.

## 8. Independent review correction round (2026-10-21)

See `docs/reviews/pr13-independent-review.md` for the correction ledger and evidence. Streaming adapters reconcile partial terminal output with streamed items, deduplicate function-call identities and fail closed on conflicting or incomplete streams. Text may stream before completion, but executable calls wait for successful completion.

Retained conversation privacy uses authoritative read-gate dependencies, independently of visible citations. Replies and pending tool arguments inherit the sources consumed by the model. Current source access is rechecked before pending dispatch and before retaining results. Old model/tool payloads without complete coverage, and payloads beyond the bounded 1,000-source contract, are withheld without deleting retained originals. Bytes already streamed before a mid-generation revocation cannot be recalled; the reply is not retained and continuation is blocked.

Apple Simulator Safari adds platform evidence; it does not replace physical-device or human assistive-technology acceptance. The runnable test-only harness is `node scripts/apple-safari.mjs`. It uses disposable local data and simulated inference, creates no native production application, and records source identity, installed runtimes, per-device XCUITest logs and screenshots.
