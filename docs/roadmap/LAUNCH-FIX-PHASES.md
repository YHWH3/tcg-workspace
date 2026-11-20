# Release review remediation prompts

Run the phases in order. Build from the reviewed Website and Workspace draft
heads in isolated branches. Use disposable local fixtures and simulated providers.
Keep prior review evidence and record the exact source and checks for each phase.
Production release, hosted staging, real provider activity, permission activation,
and owner decisions follow their existing approval steps.

## Phase 1. Publish only public Website files

> Replace the repository-root Netlify publish path with a dedicated build output.
> Include generated pages and redirects, public styles, scripts, media, metadata,
> and the public status file. Keep internal documentation, tools, services,
> private content, and stale generated files outside the artifact. Preserve the
> current design, URLs, and Workspace redirects. Configure Netlify to use that
> output. Verify representative public files resolve and internal files are absent
> from the compiled artifact.

## Phase 2. Require an explicit transcription opt-in

> Gate Workers AI audio transcription independently of the assistant. Default
> to disabled. Check the gate before reading or transmitting audio, retain the
> existing file authorization, and give the client a stable disabled response
> that keeps the original recording and avoids consuming its retry budget.
> Cover disabled, explicitly enabled, and unauthorized cases with a simulated
> provider. Make release preflight enforce the off default.

## Phase 3. Confirm captured Patron payments before fulfilment

> Preserve the checkout signature check and verify the corresponding payment
> and order with Razorpay before assigning an edition. Require captured payment,
> paid order, and matching identifiers, amount, and currency. Treat temporary
> provider trouble and authorization awaiting capture as recoverable. Keep
> authenticated webhook processing idempotent. Test the pending, mismatched,
> confirmed, and repeated callback paths with simulated provider responses.

## Phase 4. Recover Patron receipts after a provider outage

> Durably enqueue the customer receipt and team notification with payment state
> before acknowledging a new edition. Extend scheduled recovery to claim due
> email intents with expiring leases and bounded retries. Reuse the stored email
> bytes and idempotency key. Preserve accepted receipts and stop automatic
> sending when an ambiguous attempt leaves the provider's idempotency window.
> Verify a provider outage, repeated payment events, scheduler recovery, and
> preservation of deduplication and erasure with disposable data.
