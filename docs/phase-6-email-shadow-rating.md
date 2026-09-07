# Phase 6 Email shadow rating

Phase 6 is observational. It rates campaign Email recipients after provider
acceptance, legacy metering settlement, and successful `CampaignRecipient`
persistence. It never changes wallet balances, reservations, usage events,
Razorpay state, delivery state, or campaign billing.

The originating provider is persisted from `EmailProvider.providerId` (`ses`,
`mock-email`, or temporarily `smtp` while one generic commercial relay exists).
Historical null provider identity is not inferred from current configuration and
remains `PROVIDER_UNKNOWN` without authoritative internal evidence.

`CampaignRecipient.sentAt` is the sole deterministic historical timestamp for
effective-dated rate lookup. The value is application-observed, not
provider-attested. Rating never substitutes worker, replay, or webhook time.

Missing or inconsistent accepted-email evidence is recorded as `INVALID_STATE`.
Missing rates are `COST_UNAVAILABLE / RATE_NOT_CONFIGURED`; a later rerun checks
the catalog again and may append `v2 RATED` without a conflict. Monetary
calculation uses BigInt micro-paise throughout, aggregates wholesale cost before
markup, and rounds once through `RatingEngineService`.

## Separate production-hardening issue

The existing Email path performs provider send, legacy metering settlement, and
recipient persistence as separate operations. A failure after provider
acceptance or settlement can therefore leave partial evidence and may interact
with existing send retries. Phase 6 deliberately does not refactor that
atomicity gap: it observes partial state as `INVALID_STATE` and has no authority
to release funds, alter billing, mark the recipient failed, or resend Email.

Hardening this send/settle/persist boundary requires a separately scoped design
(for example, a durable provider-acceptance/outbox state machine) because it
changes operational sending and billing semantics.
