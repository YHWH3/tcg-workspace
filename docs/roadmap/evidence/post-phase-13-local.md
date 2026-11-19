# Supplemental local release and accessibility checks

Workspace source `d8ce234d9987b3a21f0723952d615e6664b5e4bd` changes
documentation and evidence only relative to the Phase 13 certification source
`91087d3d715fffa86458e04c5d7a0c962b483190`. The earlier certificate and
cross-browser matrix retain their own source identities. Relay source
`1bbc617da62168bbf094a2ad65b0140867f74fa5` is the unchanged draft PR #23 head.

| Check | Result | Verified scope |
|---|---|---|
| Workspace legacy restore and upgrade | 7/7 PASS | Synthetic SQL through 0003, 41 registered migrations applied, resulting schema through 0044. |
| Workspace integrated release upgrade | 7/7 PASS | Synthetic SQL at the R1 schema through 0034, 10 registered migrations applied, resulting schema through 0044. |
| Relay backup and restore | 4/4 PASS | Local D1 backup through 0002, upgrade to 0003 and closed-copy recovery. Original application, patron, edition and webhook rows, a pending delivery and an accepted receipt survived. |
| Chromium 400% desktop page zoom | 6/6 PASS | Real browser page zoom in a headless desktop session on macOS. 1280 CSS pixels became 320, and the device pixel ratio went from 1 to 4. Settings, keyboard menu, keyboard search, a populated Website inbox and the notification Inbox passed document reflow and visible-control geometry checks. |

The Workspace runs imported copies into disposable D1, checked the registered
prefix, compared records and attachment bytes, verified SQLite integrity and
permissions-off state, ran real search and date backfill code, and restored the
closed pre-upgrade copy. Each run peaked at eight D1 binding calls per indexer
request. The 0034 prefix was generated from the registered migration SQL and
the same synthetic rows. The migration files through 0034 match R1.

The browser run rebuilt Workspace and applied all 44 migrations in a fresh
loopback HTTPS fixture. It enabled access only in that fixture and seeded the
Website inbox by signed ingestion. It used the browser's Tabs API to set and
read back a 4x zoom. Keyboard checks included Escape and focus restoration for
the menu. It covered headless Chromium 153 at one desktop size. The initial
harness attempt used an HTTP-only fixture helper and stopped during setup. The
passing run used the existing UX lab's process-scoped TLS approach.

## Local replay

These paths are relative to the Phase 13 worktree. The local inputs, harnesses,
screenshots and full reports live under ignored `.artifacts`. The [sanitized
evidence](post-phase-13-local.json) records the reports' paths and SHA-256 hashes.
Run against the recorded checkouts to compare exact source results.

```sh
node scripts/prod-copy-rehearsal.mjs .artifacts/roadmap-local-rehearsal/r2-dwKl2t/legacy-0003.sql
node scripts/prod-copy-rehearsal.mjs .artifacts/roadmap-local-rehearsal/r2-dwKl2t/integrated-0034.sql
node .artifacts/roadmap-local-rehearsal/relay/check.mjs
NODE_EXTRA_CA_CERTS="$PWD/.artifacts/roadmap-local-rehearsal/native/tls/cert.pem" \
  node .artifacts/roadmap-local-rehearsal/native/check.mjs
```

The saved zoom runner uses a short-lived loopback fixture certificate. The
existing `ensureLabTls` helper can renew it at the same paths before replay.

## Remaining acceptance

R3 requires the owner-approved merge sequence, current Workspace and relay
backups and verified restores, the OAuth KV inventory, hosted staging, the
production rollout and the real website-to-Workspace check. Track A can start
after R3 is live and Phase 7.3 is merged. Additional live connectors, hosted
Android PWA installation, physical mobile devices and human assistive technology
remain unverified. The native zoom result applies to the named Chromium
workflows.

[Chromium Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom)
· [Playwright extension harness](https://playwright.dev/docs/chrome-extensions)
