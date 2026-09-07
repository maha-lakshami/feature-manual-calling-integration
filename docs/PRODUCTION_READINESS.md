# Production readiness

This document records confirmed hardening work that remains after the Phase 6 billing baseline. It is not a feature roadmap.

## Email send, settlement, and persistence boundary

The existing Email campaign path performs provider send, legacy metering settlement, and `CampaignRecipient` persistence as separate operations. A failure after provider acceptance or settlement can leave partial evidence and can interact with the existing retry path.

Phase 6 deliberately remains observational and represents inconsistent accepted-email evidence as `INVALID_STATE`. It must not release settled reservations, change recipient delivery state, retry provider sends, or alter campaign billing. A durable provider-acceptance/outbox design requires a separately reviewed production-hardening change. See `phase-6-email-shadow-rating.md` for the detailed boundary.

## Live storage credentials

`StorageLiveProvider` signs S3 REST requests through native `fetch`. The current adapter reads explicit `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` values; it does not resolve the standard AWS task-role credential chain.

Before deploying live storage with an AWS task role, add and validate task-role credential resolution. Until then, live storage requires externally injected static credentials and their normal rotation controls.

## Real-provider staging validation

Provider-cost abstraction and the effective-dated `ProviderRate` catalog are implemented, but real Meta, Plivo, SES, and any generic SMTP relay configuration must be validated in a controlled staging environment before provider cost can influence active settlement. Validation must cover provider identity, destination/category mapping, units, currency, effective timestamps, webhook evidence, and catalog completeness.

No real provider credentials or customer traffic should be used in pull-request CI.

## Shadow-rating cutover

Voice, WhatsApp, and Email provider-cost calculations currently operate as shadow rating and reconciliation. They are observational and do not replace legacy wallet charging.

Moving any channel to active provider-cost settlement requires a separately approved cutover with reconciliation acceptance criteria, rollback behavior, operational monitoring, and explicit confirmation that wallet, reservation, retry, and tenant-isolation invariants remain intact.
