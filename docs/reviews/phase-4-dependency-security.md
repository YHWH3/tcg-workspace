# Phase 4 dependency security review

Reviewed on 2026-10-14 against the installed lockfile. Certification captures the
current `npm audit --json` output rather than treating this document as a live
vulnerability count. No `npm audit fix`, forced peer override, or production
service change was used.

## Changes and current decision

The initial audit reported **9 high / 0 critical** package entries. Explicit
compatible development upgrades reduced this to **3 high / 0 critical**, all
from one OAuth-client advisory propagated through Agents. Package entries are
not distinct vulnerabilities.

| Package | Previous | Current | Classification and decision |
| --- | --- | --- | --- |
| `@cloudflare/vite-plugin` | 1.56.0 | 1.63.2 | Development/build toolchain. Compatible Vite 8 peer; fixed dependency chain. |
| `wrangler` | 4.135.0 | 4.150.0 | Development/deployment CLI. Matches plugin peer; updated Miniflare, Workerd and undici. No deployment executed. |
| `sharp` | 0.35.4 | 0.35.5 | Development icon generation/local asset handling. Fixed librsvg advisory. |
| `source-map-js` | 1.2.1 | 1.2.2 | Transitive development CSS/source-map tool. Compatible existing dependency ranges, lockfile update. |
| `miniflare` | 5.20260918.0-alpha | 5.20261006.2-beta | Development local Worker/D1 implementation, brought by matching Cloudflare toolchain. |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.30.0 | Reviewed exception; Agents exact peer constrains a direct patch upgrade. |
| `@modelcontextprotocol/client` | 2.0.0 | 2.0.0 | Reviewed exception; Agents exact peer constrains a direct patch upgrade. |
| `agents` | 0.24.0 | 0.24.0 | Reviewed exception; upgrading to 0.28.1 changes the 0.x compatibility line and MCP peers. |

The sharp fix is supported by the maintainer's
[GHSA-wq5f-xc86-pv6w advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
The source-map patch is supported by
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
Cloudflare plugin 1.63.2's published package metadata requires Wrangler
`^4.150.0` and supports Vite `^8.0.0`; the lockfile resolves both together.

## MCP SDK / Agents exception

[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
affects HTTP OAuth clients holding existing credentials while connecting to an
untrusted MCP server. The advisory explicitly excludes MCP servers. Patched
versions are SDK 1.31.0 and client 2.2.0; credential issuer handling is also
required for affected clients.

Current production use imports `McpServer` and `createMcpHandler` in
`worker/mcp.ts`, exposing an inbound server. Inspection found no outbound
`MCPClient`, OAuth `authProvider`, `withOAuth()`, `auth()` or `fetchToken()` use
in `worker/` or `src/`. Verification scripts use an explicit bearer header
against disposable loopback fixtures and implement fixture OAuth themselves.
**The affected OAuth-client credential-forwarding path is not reachable under
current use.** This is a source-based reachability assessment, not removal of
the installed vulnerable packages or a general statement that SDK clients are
safe.

The installed `agents@0.24.0` declares exact peers SDK `1.30.0`, client
`2.0.0`, server `2.0.0`. Installing the SDK fix alone violates those peers.
Published `agents@0.28.1` declares SDK `1.32.1`, client/server `2.3.1`, plus
additional optional peers. That coordinated migration requires its own
compatibility review and complete MCP/OAuth regression. This round retains the
server integration rather than using legacy-peer-deps or forcing incompatible
versions.

This exception needs independent review before production release. Adding
outbound MCP/OAuth client functionality invalidates the reachability exception
and blocks certification until migration and credential-issuer protection are
implemented. The certification security gate must fail for new high/critical
advisories or changed dependency paths; it must preserve the raw audit's
nonzero status and list this exception explicitly.

## Validation of the compatible fixes

Executed after installing the above updates:

- `npm ls --all --json`: exit 0, no invalid dependency or peer tree.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0; existing large client chunk and ineffective dynamic
  import warnings remain. Service worker output remains IIFE.
- `npx vitest run tests/phase4-migrations-d1.test.ts tests/phase4-budget-d1.test.ts`:
  2 files / 11 tests PASS; 13.86 seconds, actual local Miniflare D1.
- `npx vitest run tests/phase4-fixture.test.ts`: 1 file / 7 tests PASS;
  380 milliseconds. Covers port ownership, remote URL rejection, credential
  scrubbing, command throw/failure, process timeout and descendants.
- Built disposable Worker startup, all D1 migrations, admin/bob provisioning,
  SQL read and owned-group shutdown: PASS using `startFixture()` on port 8809.

These checks validate compatibility of the dependency update. The final
certification report is authoritative for results against the final source SHA;
this intermediate evidence does not replace the full matrix.
