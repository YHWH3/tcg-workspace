# Consolidated release handoff

The approved implementation roadmap ends at Track A. This index collects the
draft changes and test evidence for one later review. The current release
decision is **ENGINEERING GO / EXTERNAL BLOCKED** for the verified local scope.
Production and hosted acceptance are pending.

## Current integration pair

| Component | Verified Git source | Git tree |
|---|---|---|
| Workspace | `223cf032932c83d5790cf774f8840f87574450ff` | `cb1bc7f66dc60bb19b22184cbd754a35f484050a` |
| Website and relay | `1bbc617da62168bbf094a2ad65b0140867f74fa5` | `3eac9ec0a203205638d1abf024d639ad4b3c7ffa` |

The mirrored Website contract is version 2 and byte-identical. Its SHA-256 is
`fee8510a12a390b85ff7f58c65ada217e1bf7673972586c258d77736f264a5a4`.
The Workspace fingerprint at the joint run was `6458357f5cb7cde669f4750840bed2ce029f3ddd85e8eb8356bef4c7c5e1e681`.

| Local check | Result |
|---|---|
| Relay test suite and generated bundle | **46/46 PASS**. Rebuild left the tracked bundle clean. |
| Website → Workspace HTTPS integration | **5/5 PASS**. Covered duplicate form and single receipt, Patron lifecycle with simulated providers, outage and retry, permission-enabled ingest and grant revocation, and unsigned request refusal. |
| Workspace built-package preflight | **16/16 PASS**. Verified the generated configuration, registered migration hashes and disabled optional delivery defaults. |
| Branch ancestry and GitHub draft checks | **PASS**. Twelve Workspace drafts and the separate Website draft match the published heads. GitHub reported clean mergeability at the time checked. |

Reproduce the joint run with `scripts/verify-website-integration.mjs` using
`WEBSITE_REPOSITORY_PATH` for the pinned Website checkout,
`WEBSITE_INTEGRATION_ARTIFACT_DIR` for the ignored output directory, and
`NODE_EXTRA_CA_CERTS` for its loopback certificate. Generate the certificate
with `scripts/ux-lab/tls.mjs` and rerun `npm test` in the relay before joint
validation. Run `node scripts/release-preflight.mjs` after the Workspace build.

## Review order

Start at Workspace #12 and follow the stack below. PR #15 uses
`plan/next-phases` as its base. That base's change from #14 is documentation
only and is part of the ancestry carried by #15. The Website PR belongs to a
separate repository and has its own release gates. The review and merge steps
remain with the owner.

| Workspace change | Draft PR | Draft head | Local acceptance evidence |
|---|---|---|---|
| Workspace release candidate | [#12](https://github.com/YHWH3/tcg-workspace/pull/12) | `5b07263` | `5b07263` |
| Unified AI and MCP | [#13](https://github.com/YHWH3/tcg-workspace/pull/13) | `b6c3c4a` | `b6c3c4a` |
| Website integration and UX | [#14](https://github.com/YHWH3/tcg-workspace/pull/14) | `528b889` | [528b889](BASE-EVIDENCE.json) |
| R1 relative date fix and release rehearsal | [#15](https://github.com/YHWH3/tcg-workspace/pull/15) | `0888525` | [0888525](evidence/R1-0888525.json) |
| Phase 7 foundations | [#16](https://github.com/YHWH3/tcg-workspace/pull/16) | `6586ee1` | [3a7e17a](evidence/P7-3a7e17a.json) |
| Phase 8 operating desks | [#17](https://github.com/YHWH3/tcg-workspace/pull/17) | `53e80da` | [c3a20c5](evidence/P8-final-certification-c3a20c5.json) |
| Phase 9 everyday workflows | [#18](https://github.com/YHWH3/tcg-workspace/pull/18) | `a8c55ed` | [fa54a09](evidence/P9-final-certification-fa54a09.json) |
| Phase 10 notifications | [#19](https://github.com/YHWH3/tcg-workspace/pull/19) | `cce9d2d` | [454ee5c](evidence/P10-certification.json) |
| Phase 11 storage | [#20](https://github.com/YHWH3/tcg-workspace/pull/20) | `3962348` | [6673d6f](evidence/P11-certification.json) |
| Phase 12 database power | [#21](https://github.com/YHWH3/tcg-workspace/pull/21) | `1211693` | [fb3a0bd](evidence/P12-certification.json) |
| Phase 13 history, conflicts and mentions | [#22](https://github.com/YHWH3/tcg-workspace/pull/22) | `eb16760` | [91087d3](evidence/P13-certification.json) |
| Track A permission readiness | [#23](https://github.com/YHWH3/tcg-workspace/pull/23) | `223cf03` | [2c65e33](evidence/track-a-local.md) |

Website and relay: [YHWH3/the-common-ground #23](https://github.com/YHWH3/the-common-ground/pull/23).
Tracked Workspace `main` was `ec14454b464d9accac9a5016272579d58319ff46`. Website `main` was
`1c2ce3656baffa7719e62aa2ecb1f05c35782512`. Recheck all heads at review time.

R1 and Phases 7–13 each have a source-specific 34/34 mandatory certificate.
Track A has its own 33 browser and 13 restricted-content checks. The new joint
HTTPS results cover the exact pair above. The merged target will need its own
release certification. Browser-engine, simulator, emulator and physical-device
coverage are recorded separately in each report.

## Items for the end-of-project review

- Select the deployment checkpoint. The R1 baseline uses Workspace migrations
  through 0034 and the full stack uses 0044. The Website relay uses 0001–0003.
- Follow the [release runbook](RELEASE-RUNBOOK.md) for verified current backups,
  restore rehearsal, OAuth KV reconciliation, hosted staging, reviewed merges,
  certification on the merged target and the owner-executed R3 rollout.
- Complete deferred physical-device, human assistive-technology, hosted
  Android PWA and live connector checks. Any hosted test exposure needs its
  own authorization.
- Resolve the Website launch decisions in its
  [launch checklist](https://github.com/YHWH3/the-common-ground/blob/1bbc617da62168bbf094a2ad65b0140867f74fa5/LAUNCH_CHECKLIST.md).
  These include CA review, retention wording, draft policy pages, sample cards,
  and live delivery, payment and token setup.
- Review provider activation separately. Workspace email, push, R2 and AI
  features have their own live configuration and acceptance gates. Track A
  live permission activation requires R3, the Phase 7.3 merge and D11.

The optional share passwords, Google sign-in and items in
[the deferred backlog](deferred.md) require a separate feature decision.

## Local report provenance

| Artifact | SHA-256 |
|---|---|
| `.artifacts/release-closeout/verified-stack.json` | `6850d7f7c7fc7ce45755dacc5bd09a5ccd67ea2243d9ea0d264191bf16b5947a` |
| `.artifacts/release-closeout/relay-tests.log` | `18ae906eae9d8f036b6334544c2360bd1d3725d0f9d50a56f098796b2ec65c11` |
| `.artifacts/release-closeout/workspace-website/results.json` | `30e9e23a9cb42f55a37cbb3bc92cfe50e39df498fb4badd01ede2c0de467696f` |
| `.artifacts/release-closeout/workspace-preflight.json` | `502dd476f415eec7e06b31d0a794658152215564a4d08761e83e0e852072f338` |
