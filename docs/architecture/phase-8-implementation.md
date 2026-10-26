# Phase 8 implementation

Branch `sol/p8-desks` stacks on Phase 7. Phase 8 is in progress; no operating
desk or attention-queue implementation is claimed yet. Owner decisions D4–D6
are recorded in the roadmap. Item 8.0 precedes application work.

## 8.0: resumable certification

Implemented and accepted at `6f8a1c3b18e938f68f718383e4b51aefdb489925`.
[Source-bound evidence](../roadmap/evidence/P8-8.0-6f8a1c3.json) records the
simulated post-D1 pause and the complete resumed certificate: 34/34 mandatory
gates PASS, exit 0. Seven gates were reused after checking source, clean trees,
mode/permission contract, exact runtime versions, freshness and sealed SHA-256
artifact hashes. Reuse avoided 34.7608 minutes of original gate execution.
Unit 1644 and dedicated D1 732 counts overlap; harness 138 checks passed.

The orchestrator owns its five-second monotonic heartbeat and detects gaps over
90 seconds. A host pause interrupts the active gate and writes a resumable
PARTIAL summary. `--keep-awake` uses process-scoped macOS caffeinate; lid closure
can still suspend the host. `--resume` creates a new certificate and never
changes the source certificate. Freshness/security, dependency/lockfile,
source-integrity, browser and performance-evidence gates always rerun.
Performance evidence is recomputed from verified copied unit/D1 artifacts.
Failed, incomplete, interrupted or previously reused gates are not reusable.

The demo deliberately used a fresh pair after the user's earlier pause during
D1, so both unit and D1 were fresh in the same source certificate. The earlier
user-interrupted report remains untouched. The successful controller verified
the entire original certificate's hash inventory was unchanged after resume.
Reports, ledger and future PR text must explicitly say **resumed**.

This is tooling-only: no application code, migration, synced data collection,
MCP contract or permissions activation changed. The certificate is bound to
6f8a1c3; subsequent documentation commits do not change its tested identity.
New Phase 8 application work requires its own focused checks, browser coverage
and final phase certification. Physical hardware, human screen readers and
actual human acceptance remain external gates. No deployment or real-provider
operation took place. Usage is in [CERTIFICATION.md](../testing/CERTIFICATION.md).
