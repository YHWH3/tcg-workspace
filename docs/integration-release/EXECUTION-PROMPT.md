Claude Code
TCG Website + Workspace: execution prompt and implementation plan (corrected)
1. Mission and authorized boundaries
Act as the principal engineer completing The Common Ground website's integration with TCG Workspace. Follow this document as both the execution prompt and the implementation plan.

Integrate the Website feature into the newer Workspace release, resolve findings W01 to W07 plus the accessibility and launch-checklist findings, verify the complete workflows, and publish reviewable draft PRs with evidence.

The user has set these boundaries:

Commit and push new integration branches, and create new draft PRs.
Leave all existing PRs in both repositories unchanged and unmerged. The PRs this work stacks on are YHWH3/tcg-workspace #12 (release/1.0.0-candidate) and YHWH3/tcg-workspace #13 (feature/unified-ai-mcp). YHWH3/the-common-ground has its own, unrelated PRs with the same numbers.
Use disposable local HTTPS environments first. Creating remote infrastructure needs separate authorization.
Run automated approval tests through disposable session-authenticated fixtures. Keep these distinct from genuine human approval.
Preserve the existing website design, editorial content, Common Roots behaviour and Workspace functionality.
Do not deploy to production, apply remote migrations, activate permissions outside disposable fixtures, send real email, process real payments, mint tokens or invoke paid inference.
Save this prompt and plan as project documentation when implementation begins. Keep a durable progress ledger so interrupted work can resume without repeating completed verification.

Follow the host's active mode. In execution mode, begin implementation within the authorized boundaries. In Plan mode, prepare the plan without making changes.

2. Finding IDs
This prompt uses W-numbers. The baseline audit uses F-numbers. They map as follows:

This prompt	Audit	Summary
W01	F1	Relay delivery is not recoverable after its short retry window
W02	F2	Signed ingest fails when permissions are enabled
W03	F3	Instant checkout loses applicant answers
W04	F4	Ordinary browser resubmission conflicts on the same ID
W05	F5	Website query and reply context silently truncate answers
W06	F6	Deleting a matched person leaves future submissions linked to a tombstone
W07	F7	AI classification source checks ignore answer-body changes
A11Y	F8	The section accessibility pass excludes a serious shell contrast finding
CHECKLIST	F9	The launch checklist omits the workspace enable flag
Also apply the audit's "Handoff wording to correct" section.

Baseline audit: /Users/trinity/.codex/visualizations/2026/10/22/01a1639a-b20f-7122-bda2-3f0119209afb/website-followup-audit-2026-10-23/AUDIT.md

3. Establish and integrate the source
Start from these local sources. Recheck their state before editing.

Component	Checkout	Starting revision	Remote
Website and relay	/Users/trinity/Desktop/the-common-ground-patron (a worktree of /Users/trinity/Desktop/the-common-ground)	site-patron, cc556fc43ed0d092008f10b8ec6dce20875dbaad	YHWH3/the-common-ground
Website integration	/Users/trinity/Desktop/notion mock	feature/website-ingest, d4ff938f3a8bde4bb2680ea516a2c431e6ac1288	YHWH3/tcg-workspace
Newer Workspace release	/Users/trinity/Desktop/tcg-unified-ai	feature/unified-ai-mcp, b6c3c4a4105fc3f6ebdba557e86f638426fa7a97	YHWH3/tcg-workspace
Known ancestry, to be rechecked:

feature/website-ingest is two commits (13eecf4 signed ingest, d4ff938 Website section) on top of 5b07263.
feature/unified-ai-mcp is 40 commits ahead of 5b07263 and does not contain the website commits.
site-patron is 29 commits ahead of website main (1c2ce36), and main is its ancestor.
Steps:

Record clean or dirty status, remotes, full SHAs, ancestry and existing certification artefacts.
Preserve all user-owned changes, including the untracked HANDOFF-PREPUSH.md in the website worktree. Do not commit it unless told to.
Create isolated integration worktrees:
Workspace branch codex/website-workspace-integration from the verified feature/unified-ai-mcp head;
website branch codex/website-relay-reliability from the verified site-patron head.
Bring 13eecf4 and d4ff938 into the new Workspace branch, by cherry-pick or merge with recorded provenance. Resolve conflicts against the newer permission, approval, sync and security implementations.
Migration collision: both lines already use 0032: 0032_website_ingest.sql on the website line and 0032_assistant_conversations.sql on the release line. Keep the release migration as it is. Renumber the website migration to the next unused identifier (0033 or later), update the migration manifests and any test that names the file, and keep its contents unchanged apart from what the newer schema requires. Relay migrations continue from 0003.
Before publishing, inspect the current remote heads. Bring in relevant upstream changes before the final source freeze and rerun the affected checks.
Keep the two contract documents identical whenever behaviour or interfaces change: the website's INTEGRATION-WORKSPACE.md and the Workspace's docs/integrations/the-common-ground.md. The contract is version 2. The outbox, the grant and the AI fixes are internal; they do not change the event body. Bump to version 3 only if the body actually changes, and keep accepting versions 1 and 2.
A disposable Workspace Worker from an earlier joint test may still be listening on 127.0.0.1:8788. Inspect the listener's command, working directory and ownership.
Reuse it only if its source and fixture are verified. Otherwise use an unused port.
Stop only processes this execution created. A port number alone does not show that a process belongs to this task.
Historical test counts are reference evidence only. The existing certification summary records 34 passing mandatory gates at b6c3c4a. Integration requires a new certificate.

4. Implement the corrections
W01 and W04: durable delivery and stable submissions (website repo, services/form-relay)
The relay's only D1 binding is PATRON_DB (wrangler.jsonc). Today forms work without it and patron routes need it. Use it for a server-only delivery outbox, through a new migration.

Store:
the immutable event body and event ID;
the canonical submission hash;
the attempt count, next attempt time and lease;
the delivery state, and the last sanitized error.
Two modes, chosen explicitly with FORWARD_ENABLED. Never infer enabled state from missing configuration.
Forwarding intentionally disabled: preserve email-only behavior.
Forwarding enabled but URL, signing secret, database binding or migration absent: recoverable configuration failure; never silently fall back.
Forwarding enabled: acknowledge success only after the event is durably recorded in the outbox. The Workspace is never in the visitor's path: an outage after persistence must not delay the visitor, and delivery continues from the outbox.
If persistence fails: return a recoverable failure. Keep the browser's submission identity and answers for retry.
Persist email-send state, immutable payload and provider receipt. Retry with the stable Resend key. Treat concurrent_idempotent_requests as retryable and invalid_idempotent_request as a conflict. Never resend a known accepted email. An uncertain outcome older than the 24-hour provider window requires operator reconciliation, not blind resend. Test both sides of that window with a simulated clock.
Wording: an email-only fallback must never be reported or logged as a queued Workspace event.
Documentation: describe both modes in PATRON.md and the relay README. Update rule 8 of both contract copies to match: today it says forwarding never blocks the success screen, and with forwarding enabled the outbox write now does.
Where patron or payment state and its event share D1, commit them together with transactional batches. Recover external-provider operations through their existing idempotency and reconciliation paths.
Keep occurred_at and the event bytes stable across retries. Generate fresh timestamped HMAC headers for each delivery attempt.
Dispatch promptly after persistence. Add a scheduled recovery sweep, and add its cron trigger to wrangler.jsonc. Claim bounded batches with expiring leases, so a restart or concurrent sweeps cannot lose work.
Retry network errors, HTTP 429 and 5xx responses with bounded backoff. After the retry ceiling, keep a recoverable failure state. Do not retry other 4xx; a 409 conflict is a terminal state the admin can see.
Extend the existing bearer-token relay administration (and tools/patron_admin.py) with delivery listing, status inspection and replay. Replay uses the stored payload and the configured destination. It cannot supply arbitrary URLs or alter event content.
Retention: delivered outbox bodies are purged after a short window (propose one, for example 30 days). This is a new place where visitor answers are stored, so:
extend the existing export and erase privacy handling to the outbox;
flag the privacy page wording for the owner to confirm. Do not rewrite policy copy yourself.
Keep an idempotency key through double taps, reloads and lost acknowledgements (front end: js/site.js).
Exclude transient anti-bot and timing fields (elapsed_ms, honeypot, Turnstile token) from the submission comparison.
Reusing a key with changed substantive answers is still a conflict.
A deliberate new submission gets a new key.
Keep payloads and secrets out of logs.
Follow the official D1 batch contract and local scheduled-handler testing.

W02: scoped, revocable ingest authority (Workspace)
Replace the unaffiliated synthetic website writer with an explicitly configured service grant, sponsored by an existing active Workspace user.

Store the grant server-side, with:
its sponsor;
the destination space, and the Inbox and People destinations;
a version, and a revocation state.
Only authenticated administrator actions can configure or revoke it.
Intersect the grant's narrow destination scope with the sponsor's current canonical permissions. Do not create another login account or bypass the account cap.
Apply mutations through the existing authorization and applyChanges paths. Fence the grant version, sponsor authority and destination access at commit.
Resolve People only within the configured, authorized database. Never search unrelated private spaces.
Fail closed when the grant, sponsor or destination is unavailable, with a status the relay treats as retryable (so the outbox keeps the event, rather than losing it).
Revoking the grant must stop pending retries from writing.
Activate permissions only inside disposable fixtures.

W03: keep the application through checkout (website repo, relay)
Before starting instant checkout (PATRON_CHECKOUT=on), persist an immutable application snapshot. Enqueue its stable patron.applied event, and link the payment initiation, callbacks and later lifecycle events to that application.

Handle duplicate callbacks, abandoned and resumed checkout, and out-of-order delivery, without losing answers or inventing payment success.
In the Workspace, keep the team's edited title and review status when later lifecycle events arrive.
W05: explicit answer completeness (Workspace)
Keep the existing query fields. Add answer-completeness metadata: total length, returned length, truncation state, source version and continuation reference.
Add a bounded website_read_answers MCP tool for authorized continuation reads.
Cut at Unicode-safe boundaries (whole code points and grapheme clusters).
Recheck access and the source version on every request; a changed source invalidates an old continuation.
Update the draft_reply prompt to fetch the rest of the source before treating an excerpt as complete.
W06: respect deleted People records (Workspace)
Match only active, authorized People records.
If a reserved email points to a deleted, archived or otherwise unusable identity:
accept the submission without creating a broken relationship;
return an explicit matching outcome;
let an authorized operator restore or rebind it.
Do not automatically resurrect deleted identities, or create replacements that defeat an intentional deletion.
Test restoration and rebinding alongside ordinary email matching.
W07: bind AI decisions to their actual source (Workspace)
Include the target data and the relevant answer-body state in classification and triage dependencies.
Keep a server-only body-generation token, updated atomically when blocks are created, edited, deleted or moved. This detects added or removed answers without turning a 500-record preview into thousands of separate dependencies.
Validate source versions at three points: after inference, at human acceptance, and at execution commit. A changed dependency makes the proposal stale and requires regeneration.
Keep the existing session approval, capability fences and resumable execution.
A11Y, CHECKLIST and wording
Fix the sidebar contrast issue (F8), and make the accessibility gate fail if it comes back. Do not exclude shell regions from the section pass.
Add WEBSITE_INGEST_ENABLED, the grant setup, the cron trigger, the outbox retention window and the migration prerequisites to the website's LAUNCH_CHECKLIST.md and the Workspace runbook.
Use the terms "form-family views" and "submission-to-People relationships". Do not introduce household relationships.
Keep these distinctions clear: MCP tools versus prompts, deterministic digests versus provider inference, and event types that carry full answers versus lifecycle references.
Keep the established layouts and styling, and cover the empty, loading, failure and recovery states.
5. House rules (website repo)
Never hand-edit generated HTML. Edit the page sources (build.py, *_pages.py, content/*.json, css/, js/) and run python3 build.py. After a relay change, run python3 services/form-relay/build_bundle.py to regenerate dist/worker.js.
No em dashes in site copy.
New photos always go through the photo map (content/element-map.json, tools/page_photos.py).
Confirm that a package exists on the npm registry before installing it, and pin exact versions.
Never put secrets in tracked files, logs, chat or published evidence. Disposable local tests may use protected, untracked secret files (for example .dev.vars, which is gitignored). Never put applicant payloads in published evidence.
Do not change content/patron.json backend.enabled or featured.show_samples, and do not clear the draft flags in content/policies.json. These are owner decisions recorded in LAUNCH_CHECKLIST.md.
6. Verification and acceptance
First reproduce each defect against its baseline. Then replace the expected-defect assertions with regressions that demonstrate the fix.

Run these groups against disposable data and the final integrated source.

Delivery:
an outage longer than the old retry window;
restart, concurrent dispatch, an expired lease;
a lost acknowledgement, a duplicate receipt, a conflict;
dead-letter recovery and authorized replay;
D1 unavailable with forwarding enabled: the visitor gets a recoverable failure, the answers survive in the browser, and a retry with the same submission ID sends exactly one email and creates exactly one event;
forwarding disabled: email-only behaviour is unchanged.
Authorization:
valid, invalid and expired signatures;
each permission mode, and private-space isolation;
sponsor disablement, destination changes, and grant revocation during processing.
Applications and matching:
both checkout paths, with complete answers;
callback retries and lifecycle ordering;
deleted People, restoration, and changed email addresses.
AI and MCP:
long Unicode answers (emoji, combining marks, right-to-left text) and continuation access;
source changes, and body additions and deletions;
stale suggestions and approvals;
prompt-injection resistance.
Bulk baseline (the existing test, kept):
send 1,000 submissions from 400 distinct senders, across all six families;
verify they produce 400 People;
create two 500-record previews, approve both through labelled test sessions, execute both, and verify all 1,000 intended actions;
inject partial failure and lost acknowledgements, then verify the final state, the audit records and bounded D1 usage.
Bulk mixed lifecycle (an added test):
seed 400 active People, plus some deleted or archived People;
send 1,000 submissions: 400 from the active People's emails, 550 from distinct new emails, and 50 from the deleted or archived People's emails;
verify 400 matches to existing People, 550 new People (950 active in total), and 50 explicit unusable-identity outcomes;
verify there are no links to deleted records, and the deleted records are not resurrected.
Browser and website:
Chromium, Firefox and WebKit (Playwright Firefox is installed);
compact, tablet and desktop sizes; keyboard; light and dark modes;
the existing website gates: tools/design_check.py, tools/phone_profile.py --full --strict tap,text, tools/test_e2e.py, tools/edge_cases.py, all three Roots suites, and the relay and token test suites.
Reuse the available native Safari and Android harnesses, and say clearly which results come from simulators, emulators or physical devices.
Release:
run npm run certify:ai in the Workspace, using the current mandatory manifest, plus integration-specific gates;
keep the migration, offline-sync, service-worker, approval, security and recovery checks.
Website check commands (run from the website repo root; the Python tools need ~/.venvs/tcg-culture/bin/python):

python3 build.py && python3 services/form-relay/build_bundle.py
~/.venvs/tcg-culture/bin/python tools/test_e2e.py
~/.venvs/tcg-culture/bin/python tools/edge_cases.py
~/.venvs/tcg-culture/bin/python tools/design_check.py
~/.venvs/tcg-culture/bin/python tools/phone_profile.py --full --strict tap,text
(cd services/form-relay && npm test); (cd services/patron-token && npm ci && npm test)
Use locally trusted HTTPS, with no public exposure, and do not change global device trust without authorization. Invoke the scheduled recovery explicitly in local tests.

Prepare a genuine browser review separately from the automated approval fixtures. Never claim a fixture approval was a real person's decision.

7. Certification, publication and completion
Commit the source before final certification. Record for both repositories:

the SHAs, tree hashes and fingerprints;
the contract version and the migrations;
each test's exit status, and where its artefacts are.
Any source change invalidates the evidence it affects.

Publish:

A Workspace draft PR on YHWH3/tcg-workspace, targeting feature/unified-ai-mcp, stacked after the existing release work, without modifying #12 or #13.
A website draft PR on YHWH3/the-common-ground, targeting main. This publishes site-patron for the first time, so the PR description must say that it carries:
the whole unpublished Patron programme (29 commits), as well as the relay fixes;
sample patron cards that are still on;
policy pages that are still drafts for the CA.
Documentation:
source discovery;
a defect-resolution ledger (W and F IDs side by side);
a feature inventory and a platform matrix;
reproducible integration evidence.
A deployment runbook covering:
configuration and secret names (never values);
migrations (in order, including the renumbered one), backups and rollback;
the cron trigger, monitoring, and unresolved owner decisions.
Attach every newly created PR to this chat.

Use these completion decisions:

ENGINEERING GO: all mandatory engineering checks pass, and the corrected source is ready for review.
ENGINEERING GO / EXTERNAL BLOCKED: the engineering checks pass, and each external acceptance or launch gate that is still unavailable is named.
HOLD: any W01 to W07 defect, required migration problem, failed mandatory check or incomplete engineering workflow remains.
Missing engineering evidence cannot become a pass by being relabelled external. Do not present local certification as production deployment, legal approval, provider activation or physical-device acceptance.

