# TCG Workspace Companion

A small **local** command-line companion that lets you chat with, and act on, your TCG Workspace using **your own ChatGPT plan**. It signs in with OpenAI's "Sign in with ChatGPT" open-source plan-usage flow, sends inference to the public Responses API, and calls Workspace through Workspace's existing MCP server.

> **Not verified against a real ChatGPT account in this repository's tests; real-account acceptance requires a consenting eligible ChatGPT Plus/Pro account.**

## Why this runs locally (policy)

OpenAI's documented ChatGPT plan usage for third parties covers **open-source and locally/self-hosted tools**. Paid or centrally hosted remote apps must apply through OpenAI's interest form ("If you're interested in offering it in a paid or remotely hosted app, complete the interest form" — [Overview](https://developers.openai.com/siwc/token-sharing-open-source/)).

TCG Workspace's main deployment is a hosted Cloudflare Worker, so plan-backed inference happens **only in this companion, on your machine, with your own credentials**. The companion:

- never sends ChatGPT tokens to the Workspace server or to any host other than `auth.openai.com` / `api.openai.com`;
- never uses ChatGPT `backend-api` endpoints, never scrapes sessions or cookies, and never impersonates another client;
- **never falls back to API-key billing or any other billing path.** If plan usage fails or is not granted, inference stops.

The Workspace server never sees your ChatGPT credentials. It only sees ordinary Workspace MCP calls made with a separate Workspace OAuth token. You granted that token on Workspace's consent page, where you chose which spaces the companion may access.

## Requirements

- Node.js 22 or newer. Only built-ins are used: no npm install and no extra dependencies.
- A browser on the same machine (for the two OAuth consents).
- An eligible ChatGPT plan, plus a TCG Workspace account.

## Usage

```sh
node companion/bin/tcg-companion.mjs login            # "Continue with ChatGPT" (new registration)
node companion/bin/tcg-companion.mjs accounts         # list saved ChatGPT accounts (* = active)
node companion/bin/tcg-companion.mjs use <label>      # switch the active account
node companion/bin/tcg-companion.mjs login --account <label>   # sign in again to a saved account
node companion/bin/tcg-companion.mjs login --label work        # add another account/workspace
node companion/bin/tcg-companion.mjs login --account <label> --enable-plan  # re-request plan usage after declining
node companion/bin/tcg-companion.mjs models           # models available to the active account
node companion/bin/tcg-companion.mjs connect https://workspace.example.com
node companion/bin/tcg-companion.mjs chat [--model <slug>]
node companion/bin/tcg-companion.mjs logout [<label>]
```

Global option: `--config-dir <dir>` (default `~/.config/tcg-workspace-companion/`). Endpoints and the issuer are compiled-in constants. They are **not** configurable through environment variables or flags.

In `chat`, the status header shows the active ChatGPT account, the model, `ChatGPT plan usage: active|disabled`, and a **Manage usage** hint (ChatGPT Settings → Usage). Type `/model <slug>` to switch models and `/exit` to quit.

## What data goes where

| Data | Sent to | Never sent to |
|---|---|---|
| ChatGPT authorization (code, PKCE verifier, refresh token, `id_token_hint`) | `auth.openai.com` only | Workspace, any other host |
| ChatGPT access token | `api.openai.com` (`/v1/models`, `/v1/responses`) only | Workspace, any other host |
| Your chat messages, plus Workspace tool results the model asked for | `api.openai.com/v1/responses` with `store:false` | — |
| Workspace OAuth token | your Workspace origin (`/token`, `/mcp`) only | OpenAI |
| Host id (`urn:uuid:…`, opaque) | `auth.openai.com` as `ext_agent_host_id` | — |

Local files under the config dir (directory `0700`, files `0600`, written atomically):

- `host-id.json`: the stable `ext_agent_host_id`, created before the first sign-in and kept across sign-outs.
- `accounts.json`: account labels and the active pointer. It holds no tokens.
- `chatgpt-<hash>.json`: one record per registration: `{email, issuer, subject, client_id, ext_agent_host_id, id_token, access_token, refresh_token, token_type, expires_in, scopes[], saved_at}`.
- `workspace.json`: Workspace OAuth credentials, kept in a **separate** file.
- `settings.json`: your preferred model.
- `*.lock`: short-lived refresh locks.

## Security model

- **Loopback callbacks.** Both OAuth flows use a one-shot listener bound to `127.0.0.1` only. The ChatGPT flow uses `http://127.0.0.1:<port>/auth/callback` (default port 1455, which falls back to an ephemeral port; only the port varies). The Workspace flow uses `http://127.0.0.1:<port>/callback`. Each listener:
  - is started before the browser opens;
  - serves only the exact callback path, and only to `GET` requests;
  - requires `Host: 127.0.0.1:<port>`, as a DNS-rebinding defense;
  - rejects any cross-site request (a foreign `Origin`, or `Sec-Fetch-Site` cross-site/same-site) that is not a top-level document navigation;
  - validates `state`;
  - accepts one callback, then closes.

  The companion exposes no other local HTTP API, so a web page cannot drive it.
- **Sign in with ChatGPT** follows the spec:
  - `dynamic_agent_client` plus `agent_name_hint=TCG Workspace Companion` are sent only on first registration. Later sign-ins use the saved issued `client_id`, `id_token_hint` and `login_hint`.
  - Every attempt gets a fresh `state`, `nonce` and PKCE S256 verifier.
  - A new-registration callback without an issued `client_id` is treated as incomplete.
  - A reauthorization callback that carries a different `client_id` is rejected.
  - The ID token is verified with RS256 against the JWKS discovered from `https://auth.openai.com/.well-known/openid-configuration`. Discovery is pinned to that issuer and host. The checks cover issuer, audience (the issued client id), `exp` and `nonce`.
  - For a returning account, the validated `sub` must match the saved account before any credential is replaced.
  - Plan usage counts as enabled only when the **token response** grants `chatgpt.tokens.use.direct`.
- **Fetch guards.** Each credential travels through a fetch wrapper that is allowlisted to its own origins and never follows redirects.
- **Refresh.** Near expiry the companion refreshes with a form POST (issued `client_id`, `refresh_token`, `resource`, no `scope`). Refreshes are serialized in two ways: by an in-process promise, and across processes by an `O_EXCL` lock file with stale-lock recovery. The record is re-read after the lock is acquired, so a rotation made by another process is reused and not raced.
- **Sign-out.** The refresh token is revoked at the discovered `revocation_endpoint`, with bounded retries on 5xx or network errors. Tokens are then cleared locally. The account-to-client mapping and the host id are kept.
- **Tokens stay out of output.** All log output goes through a redactor. A printed authorize URL never includes `id_token_hint`.
- **Tool safety in chat.**
  - Workspace MCP tools are offered as function tools grouped in one `namespace` tool (`tcg_workspace`).
  - `execute_preview`, `decide_approval`, `request_approval`, `undo_change`, `publish_page`, `publish_moodboard` and `share_moodboard` are never offered. Any call to an excluded or unknown tool is also refused at execution time.
  - Tool output is truncated, then wrapped as `{"untrusted": true, …}` data. The instructions tell the model never to follow instructions found inside tool output.
  - A turn runs at most 8 tool steps.
  - When a tool returns `humanApprovalRequired` / `reviewUrl`, the companion prints the review URL and asks you to approve in your signed-in Workspace browser. It only prints URLs on your Workspace origin. **The companion never approves.**

## Troubleshooting

| Code / symptom | Meaning | What to do |
|---|---|---|
| `access_denied` | You declined in the browser. | Run `login` again when you're ready. |
| `registration_incomplete` | The callback carried no issued client id. | Run `login` again. |
| `client_mismatch` | The reauthorization returned a different client id. | The result was rejected. Retry `login --account <label>`. |
| `identity_mismatch` | A different ChatGPT account signed in than the one you selected. | Use `login` (without `--account`) to add it as another account. |
| `id_token_invalid` | The ID token failed signature, issuer, audience, expiry or nonce checks. | Nothing was saved. Retry; if it persists, report it. |
| `invalid_grant` (sign-in) | The code was rejected and has been discarded. | Run `login` again. |
| `plan_usage_disabled` | `chatgpt.tokens.use.direct` was not granted. | `login --account <label> --enable-plan` |
| `reauth_required` | The refresh token is unusable (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated` or `refresh_token_reused`), or you are signed out. | `login --account <label>` |
| `invalid_client` | The registration is not accepted. | This is a configuration problem. Register again with `login`. |
| `subscription_sharing_usage_limit_exceeded` (429) | You hit the usage limit for your plan or for this app. | Chat pauses. Open ChatGPT Settings → Usage. The companion does not guess a reset time. |
| `subscription_sharing_usage_unavailable` / `subscription_sharing_user_unavailable` (503) | Plan usage is temporarily unavailable. | The companion retries with bounded backoff; try again later. |
| `subscription_sharing_user_not_eligible` (403) | Plan usage isn't available for this user, workspace or policy. | No retry. Check eligibility. |
| `subscription_sharing_unsupported_capability` (400) | An unsupported input, tool, model or feature was sent (see `param`). | The same request is not retried. Report the `param`. |
| `subscription_sharing_route_not_supported` (403) | The method or endpoint isn't supported. | Report it (this is a bug). |
| `subscription_sharing_invalid_user` (401) | The subscriber context could not be validated. | Note the request id. Sign out and sign in again. |
| `chatpass_v2_scope_not_authorized` / `chatpass_v2_invalid_authorization_context` (403) | The grant doesn't authorize the operation. | Check the account's granted scopes. Not retried. |
| HTTP 401/403/503 `{detail}` before the stream starts | Direct-route admission failed. | The detail is shown as diagnostic text. Only a 503 is retried. |
| `stream_ended` / `incomplete` | The stream ended without `response.completed`. | Treated as a failure. Retry the message. |
| `workspace_discovery_untrusted` | Workspace OAuth metadata points off-origin. | Check the origin you passed to `connect`. |

Error messages keep the HTTP status, the error code, `param` and the request id.

## Official documentation

- Overview: https://developers.openai.com/siwc/token-sharing-open-source/
- Registration and sign-in: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- Accounts and sessions: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Models and inference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- Token reference: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- Errors and recovery: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- Preview limitations (Responses requirements, namespaces / `additional_tools`): https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- UI/UX guidelines: https://developers.openai.com/siwc/ui-ux-guidelines
- Function calling, "Defining namespaces": https://developers.openai.com/api/docs/guides/function-calling
- Responses API reference (`Namespace` tool object, `FunctionCall.namespace`, `AdditionalTools` input item): https://developers.openai.com/api/reference/resources/beta/subresources/responses/methods/create/

## Implementation notes and known gaps

- **Tool grouping.** Tools are sent as one top-level `{"type":"namespace","name":"tcg_workspace","description":…,"tools":[{"type":"function",name,description,parameters,"strict":false}]}`. Returned `function_call` items are assumed to carry the bare function name plus a separate `namespace` field, which is replayed as-is. As a precaution, an exact `tcg_workspace.` prefix on the name is also accepted, and the excluded-tool and unknown-tool checks still apply after it is stripped. The documented alternative, an `additional_tools` input item with `role:"developer"`, is not used.
- **History replay.** With `store:false`, each request carries the full history in `input`: user messages, assistant text, `function_call` items without item ids, and `function_call_output` items. `reasoning` items are dropped because they are not replayable without stored or encrypted content.
- **Not interpreted.** `earliest_refresh_at` from the token response is stored but not interpreted, because the docs list the field without defining its format. Refresh triggers 5 minutes before `expires_in` elapses.
- **Re-enabling plan usage.** `--enable-plan` sends `prompt=consent`. The docs say `force_reconsent=true` should be used only after OpenAI confirms deployment for an integration.
- **Manage usage link.** The docs say to link "ChatGPT Settings → Usage" but give no deep-link URL, so the companion prints that path next to `https://chatgpt.com`.
- **Tests.** All tests use stubbed `fetch` and local loopback servers (`tests/companion-*.test.ts`): `npx vitest run tests/companion-*.test.ts`. No real OpenAI or Workspace calls are made.
