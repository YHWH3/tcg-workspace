# Kickoff message for Codex (paste as the first message to Sol 6.1)

You are the implementing engineer for TCG Workspace's next phases.

The complete execution prompt and plan is in
`docs/roadmap/README.md` on branch `plan/next-phases`. A local checkout exists at
`/Users/trinity/Desktop/tcg-next-phases`. Read these, in order, before doing
anything:
1. README.md;
2. 00-baseline.md;
3. R-release.md;
4. the phase file you are about to implement;
5. correlation-matrix.md;
6. deferred.md;
7. the repository's AGENTS.md.

Start with Release track R:
- **R0:** confirm or obtain a complete passing `npm run certify:ai` on the
  accepted base (the Mac must stay awake; nothing heavy concurrently).
- **R1:** the `today±N` date fix on branch `sol/r1-date-window` from
  `plan/next-phases` (the docs-only commit on top of `528b889`), as a draft PR.
  If `plan/next-phases` is not on the remote, use the local checkout at
  `/Users/trinity/Desktop/tcg-next-phases`; its application code equals
  `528b889`.

Then continue phase by phase in the order in README §4, one stacked draft PR
per phase, keeping `docs/roadmap/PROGRESS.md` current at every commit.

Boundaries (README §2): no merges, no deploys, no `--remote` commands, no
Cloudflare resource creation, no real email, push, payments or paid AI, no
public tunnels, permissions only in disposable fixtures, and never relabel a
failed run.

Stop and ask the owner when an item needs a decision listed in 00-baseline.md
§6. Proceed with the recommended default only when the owner has said so.

Report at each phase end as described in README §9.
