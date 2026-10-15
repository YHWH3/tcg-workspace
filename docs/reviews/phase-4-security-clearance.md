# Phase 4 security clearance and merge decision

Reviewed 2026-10-15. The original Desktop checkout started clean at
`f176247e444b393073c226f83163ab927003e832`. That commit and
`grok/phase-4-continuation` remain unchanged. Dependency evaluation is isolated on
`security/phase4-mcp-oauth-upgrade`, targeting `codex/phase-4-operating-rhythm` in a
separate PR. Neither PR is authorized to merge or deploy.

## Advisory and threat model

[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
affects SDK `>=1.12.0 <1.31.0` and client `>=2.0.0 <2.2.0`.
The attacker controls an outbound MCP resource server and advertises a different
authorization server. A victim client holding credentials for a legitimate
issuer can then send its refresh token/client secret or signing assertion to
the substituted issuer. HTTP OAuth clients are affected; inbound MCP servers
and stdio clients are excluded by the advisory. Installed package presence is
distinct from a reachable production execution path.

The application call graph is:

1. `worker/index.ts` constructs `OAuthProvider` per request. The provider serves
   DCR/token/metadata and validates inbound bearer tokens before `/mcp` dispatch.
   The resource audience is this request origin plus `/mcp`.
2. `worker/oauth.ts` parses the registered redirect and PKCE request, creates a
   browser-cookie-bound consent handle, verifies the workspace password, then
   derives identity from the stored user. `approveConsent()` returns the original
   consent request; query/form values cannot substitute its identity or state.
3. `worker/mcp.ts:mcpApiHandler.fetch()` rejects missing/deleted identities and
   constructs a fresh `createMcpHandler` and `McpServer` for that request. Tool
   writes use the verified user, shared mutation path and attributable journal.
4. No production source imports SDK client transports, `MCPClient`, `withOAuth`,
   `auth`, `fetchToken`, OAuth client providers or outbound MCP connections.
   Verification clients use explicit fixture bearer headers and loopback URLs.
   `worker/remotefile.ts` imports bounded HTTPS media, not MCP/OAuth credentials.

**Reachability decision:** this advisory is not exploitable through the reviewed
Phase 4 application architecture. The application neither holds outbound MCP
OAuth-client credentials nor calls the affected token-dispatch implementation.
This conclusion does not audit an independently deployed version or approve
future outbound-client features. No production resources were inspected or
changed during this assessment.

The old published `sdk@1.30.0` implementation was downloaded into ignored test
evidence, without changing `node_modules`. Its `authInternal()` accepts discovered
authorization-server metadata and passes stored client information/refresh tokens
to `refreshAuthorization()` without issuer binding. An isolated fetch stub with
non-secret fixture credentials reproduced forwarding to a substituted `.invalid`
issuer. SDK 1.32.1 rejected the same request before token transmission. No real
servers, credentials or third-party accounts participated. The committed SDK
1.x/client 2.x regression asserts issuer mismatch fails before the fetch stub is
called. The provider expiry test bundles the real provider with only its unused
WorkerEntrypoint base stubbed, ephemeral KV and a controlled clock; actual
application consent and transport behavior is exercised separately against the
built Worker.

## Minimum supported coordinated upgrade

Registry peer metadata was queried live, rather than inferred from prior notes.
Agents 0.25.0, 0.26.0, 0.27.0 and 0.28.0 still require affected exact peers.
**0.28.1 is the first published compatible patched set**:

| Package | Certified baseline | Security branch |
| --- | --- | --- |
| agents | 0.24.0 | 0.28.1 |
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.1 |
| @modelcontextprotocol/client | 2.0.0 | 2.3.1 |
| @modelcontextprotocol/server | 2.0.0 | 2.3.1 |
| @modelcontextprotocol/core | 2.0.0 | 2.3.1 |

[Official release 0.28.1](https://github.com/cloudflare/agents/releases/tag/agents%400.28.1)
includes the patched peers and subsequent same-origin transport redirect
protection. [Current handler documentation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
preserves the per-request SDK-v2 factory and stateless legacy-client lane used
here. Intermediate releases remove experimental Channels entry points and add
optional harnesses; this application imports none of them. No Agent class,
storage migration, new Worker binding or outbound feature was introduced.
The existing OAuth provider remains 1.2.1. SDK v1 fixture clients interoperate
with the SDK v2 server through the existing handler; tools/prompts are unchanged.

The dependencies were installed as one coordinated manifest update. An initial
sequential install was rejected by npm's peer resolver; no force/legacy-peer
option was used. The final exact peers resolve with `npm ls --all --json` exit 0.
Raw audit after installation reports **0 total vulnerabilities, exit 0**. The
certification classifier has no advisory exceptions; old/new high or critical
findings fail. Advisory removal is verified by the final run's raw audit, not
just these version numbers.

Patched OAuth clients still require `expectedIssuer` for bundled providers and
issuer-preserving stored credentials. Adding outbound OAuth later requires a
new threat model; an upgrade alone cannot authorize unsafe credential storage
or direct low-level exchanges. This application has no such credentials to
migrate or rotate.

## Regression and evidence contract

`scripts/phase4-oauth-security.mjs` adds mandatory checks inside the existing
base-MCP gate: unsafe/unregistered redirects, consent browser binding and state,
single-use consent/code, wrong verifier/client, refresh rotation, cross-client
revocation isolation, access/grant revocation and recovery. The base gate also
invokes a prompt and expires a disposable workspace session before testing login
recovery. Existing deleted-user, login/PKCE/tool/undo tests remain intact.
The multiuser gate adds concurrent writes with caller/journal attribution.
`tests/mcp-oauth-security.test.ts` covers both patched client issuer checks and
provider access expiry/audience/refresh with a controlled clock. All are included
in the existing explicit manifests or unit discovery; no separate framework.

Before committing, targeted security/migration tests passed **30/30**, the three-engine v9 run passed **75/75**, and typecheck/build passed. The base-MCP and concurrent multiuser checks run against the built disposable Worker before final certification. The complete final
acceptance command is **`npm run certify:phase4`**, executed after committing.
The generated `.artifacts/certification/<SHA>-<timestamp>-complete/summary.json`,
source fingerprint, report, raw audit and all logs identify exactly the branch
and source tested. The security PR body/comment records that artifact and its
actual results; no security-branch result certifies a different Phase 4 HEAD.
The previous `f176247` artifacts remain available unchanged.

## Focused final source audit

No new high-impact application defect was confirmed in this round. The review
traced, without rewriting, the existing high-risk boundaries:

| Boundary | Source evidence and required regression |
| --- | --- |
| Sync/outbox/approval CAS | `worker/sync.ts` batches record, outbox, journal and execution checkpoint under revision/lease guards; `worker/approvals.ts` checks current approver and gates generic sync. Existing actual-D1 security/event/budget and v9 approval tests remain mandatory. |
| Files/archive | Migration 0011 preserves referenced bytes and terminal deletion markers; upload routes reject resurrection and enforce completion/quota CAS. Archive leaves identities/relations/views intact. The three-engine browser journey now reopens through the normal Archived sidebar before restoring. |
| MCP idempotency/undo | Durable argument hash is checked before adopting a request; saved plans retain IDs/checkpoints; owner/admin authorization precedes undo reservations/fences. Bounded inverse journal/conflict cases remain mandatory. |
| Public forms/notifications | Server-only receipt/approval state, Turnstile production fail-closed checks, scoped notification reads, leased form recovery and upload claims remain covered by actual-D1 security and real Worker/browser tests. |
| Cron | Durable cursors, scheduled-time rotation, recipient dedupe, conditions and recoverable execution checkpoints remain covered by reminder/date-offset/resource regressions. |
| Mentions/embeds | Per-request live record lookup, page-first ambiguity behavior and validated allowlisted block mapping remain in MCP/D1/browser tests. Phase 0–4 is a shared authenticated workspace; this review does not imply Phase 5 record ACLs. |

The archive path is functional and discoverable: sidebar **Archived** → database
name → **Archived** banner → **Unarchive**, or its sidebar restore button.
No redesign was needed. Attachment deletion had no explanation of irreversible
binary reclamation; a small visible notice now says deleted attachments cannot
be restored and recommends keeping another copy. The existing three-engine
offline deletion test asserts this notice before deleting. This is a
nonblocking UX clarification, not a newly claimed security defect.

## Deliberate merge and release decision

The certified Phase 4 baseline remains a valid source-integration baseline with
the documented non-reachable dependency exception. A supported patched set is
now available, so the recommended **Phase 4 source merge decision is HOLD until
the focused security PR is reviewed/integrated and the resulting Phase 4 HEAD
is completely recertified**. Do not merge either PR automatically. The security
PR may be ready for independent review after its own complete green run.

**Production deployment: HOLD.** A clean audit does not complete physical-device,
manual assistive-technology, native zoom, production configuration, backup/restore,
rollback or operational acceptance. Use [the compact release checklist](phase-4-release-checklist.md).
No production resources, credentials, D1 state or deployment were modified.
