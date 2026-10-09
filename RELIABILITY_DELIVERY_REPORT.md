# Reliability fixes and automatic full-audience announcements

## Baseline and scope

This delivery modifies the exact saved local implementation with dynamic API-key panels, authorization fixes, five workflow/recovery fixes, subscription migration, **196 tracked/deliverable files and 592 passing tests**. The baseline was verified against the prior audit hashes, copied to a separate comparison directory, and its full suite was rerun successfully. It is not vanilla GitHub HEAD.

This report describes implemented code and executed local tests, not production or live Telegram/PasarGuard verification. No general Cloudflare/D1 optimization, data retention work, dependencies, new Cloudflare products, deployment, commit, push, production query, secret change or production migration was performed.

## Validation results

| Check | Actual result |
|---|---|
| Baseline `npm test` | 592 passed; zero failed/skipped |
| Final `npm test` | 639 passed; zero failed/cancelled/skipped/todo |
| New permanent regressions | 47 tests: 40 reliability/transport/workflow, 4 schema, 3 independent-connection wallet concurrency |
| `npm run typecheck` | Passed |
| Wrangler `deploy --dry-run` | Passed; local bundle only, no deployment |
| Isolated Wrangler D1 0022 → 0023 | Passed; 28 prior application tables preserved across original columns in the representative synthetic fixture; zero foreign-key violations |
| Repeat versioned Wrangler migration application | Passed; no migrations to apply |
| Schema transaction rollback/raw repeat | Tested; rollback preserves records; raw SQL second application rejects duplicate schema operations, not silently reapplied |
| Ambiguous historical payment-token collision | Tested; migration fails inside transaction and rolls back, preserving financial records |
| Previous panel authorization/security implementation | Byte-identical to the 592-test baseline; existing regressions included in full suite |

There is no lint script in this project. No lint check is reported as executed. No dependencies were installed or upgraded. The tests use isolated SQLite/Worker mocks; the local Wrangler D1 test uses the real local D1 runtime. This is not proof of production-data safety or remote Cloudflare concurrency performance.

## 1. Wallet payment concurrency

### Root cause

`src/db/wallet.ts::payOrderWithWallet()` previously calculated an expected post-debit balance outside the write transaction. Two different orders could both read the same balance. Their debits could both execute, while the second balance-equality-gated ledger insert would not match, leaving a debit without its ledger. The old refund recovery heuristic could also credit an already-refunded order again after an unrelated payment lowered the balance.

### Implemented fix

- The ledger insert is the unique **claim**, inside the same D1 transactional batch as the debit.
- The claim selects the authoritative current balance, checks funds, customer, stable payment token and existing order payment, and captures `balance_after` at serialization time.
- The balance update is gated by the newly generated ledger claim ID. A losing/duplicate request cannot debit.
- A stable `payment_token` survives re-pointing the ledger from checkout token to real order ID. Retries reconcile the committed ledger and verify customer, amount and absence of refund, including uncertain batch responses.
- `refundOrderWalletPayment()` uses an atomic refund-claim/effect batch. It no longer infers a missing credit from comparison with an old ledger balance.
- SQL funded-order insert guards require a matching unrefunded payment claim. The after-insert trigger links the ledger to the new order **in that order-insert transaction**.
- `recoverUnlinkedWalletPayments()` compensates interrupted pre-order reservations only after 15 minutes, at most two per existing cron sweep. Both its candidate query and atomic refund guard check **order ID and idempotency key**. Historical orders without idempotency keys cannot be mistaken for orphans. Database errors do not prove absence.
- A late funded-order insertion after compensation is rejected by the SQL guard. Linked orders and fresh reservations are not refunded.

**Atomicity boundary:** the existing checkout remains a durable two-stage reservation/compensation saga, not a single transaction covering every checkout step. Debit + ledger are atomic; funded order + initial event + ledger linkage are atomic. A crash between those transactions leaves a durable reservation which the scheduled recovery compensates. This preserves existing checkout/error/refund behavior and ledger history. Historical inconsistencies are not automatically repaired.

### Evidence

`tests/reliabilityRegression.test.ts`: synchronized pre-reads for different/same orders, insufficient funds, SQL trigger failure rollback, committed batch with lost response, token/link replay, cross-customer/amount substitution, missing payment order guard, refund after later debit, orphan recovery, late order rejection, linked/fresh protection, legacy null-key protection.

`tests/walletConcurrencyConnections.test.ts`: three deterministic tests use two separate worker threads and two actual SQLite connections to a temporary file, synchronized pre-transaction reads and serialized `BEGIN IMMEDIATE` batches. Different orders produce two complete claims/debits; same order charges once; insufficient funds produce only one debit. SQL—not mocked balance responses—determines outcomes. This still does not simulate Cloudflare's remote D1 infrastructure.

## 2. Migration handoff notification recovery

### Root cause

`src/handlers/serviceMigration.ts::notifyCustomer()` stamped `customer_notified_at` after `TelegramApi.sendMessage()`, whose existing failure handling could return null without throwing. An API rejection could therefore be recorded as delivery.

### Implemented fix

- New `src/telegram/delivery.ts::deliverMessage()` consumes explicit classified delivery results.
- `src/telegram/api.ts::sendMessageDelivery()` accepts success only when HTTP success, `ok:true`, and a positive integer `message_id` are confirmed. It uses an eight-second timeout, refuses redirects, bounds parsed response size, and returns redacted classification codes rather than upstream descriptions.
- `notifyCustomer()` stamps delivery only for `kind:'sent'`. All unsuccessful/ambiguous outcomes remain pending.
- Existing service lock and current active-generation join remain intact. No entitlement, source revocation or destination activation semantics changed.
- Existing cron/status execution retries pending handoffs. Repeated execution after confirmed local stamping does not resend. Permanent failures remain visible as pending/recoverable; there is no new delivery escalation UI or exactly-once guarantee.

A timeout or crash after Telegram accepted a message but before D1 recorded success can lead to a duplicate on retry. Telegram offers no application idempotency key/reconciliation lookup for this send; this implementation deliberately does **not** claim exactly-once delivery. Handoff retry cadence remains the existing five-minute schedule; the persisted rate-limit pause described below applies to announcements, not all Telegram messages globally.

### Evidence

API error, transport timeout, malformed success and rate-limit handoff tests confirm a null delivery stamp, subsequent confirmed retry, and no repeat send after stamping. Existing service-migration suite remains passing. The two adjusted existing test fixtures now return realistic confirmed Telegram `message_id` results; no assertions or tests were removed or weakened.

## 3. Announcement delivery ownership

### Root cause

The prior stuck-delivery sweep reset all `sending` recipients without a durable lease/owner, including still-active workers. Overlapping chunks could reclaim and resend live work.

### Implemented fix

`src/db/announcements.ts` now uses:

- A singleton D1 broadcast dispatch claim, acquired by an atomic conditional update with unique owner and three-minute lease.
- Per-recipient owner and three-minute lease; recipients are selected/claimed atomically, and workers send only their won rows.
- Lease renewal before sending and owner/valid-lease checks when booking outcomes.
- Sweeping **only expired** claims; never declaring an unknown outcome delivered.
- Separate durable attempt-start evidence. The `finally` cleanup releases only unattempted claims. A failure after the send starts stays leased for later unknown-outcome recovery instead of becoming immediately eligible for duplicate sending.
- Expired attempted claims consume a bounded failure attempt, preventing endless unknown retries.
- Durable global pacing and pause state across announcements and Worker instances.

A resumed Worker cannot book success with an obsolete owner or expired lease. D1 fencing prevents concurrent valid ownership; it cannot cancel an external request already accepted by Telegram, or absolutely fence a severely suspended process outside D1. Unknown transport outcomes remain at-least-once and may produce duplicates, never false confirmed-delivery counts.

### Evidence

Tests hold a live send while another Worker attempts acquisition/sweep; only one valid owner sends. Other tests cover expiry/restart, stale/substituted owner booking, deadline cleanup, and booking failure after external acceptance (including documented duplicate delivery after lease expiry).

## 4. Dedupe failure classification

### Root cause

`src/db/dedupe.ts::claimUpdate()` caught database insert failures and returned replay, silently treating an operational failure as a proven duplicate.

### Implemented fix

- `INSERT ... ON CONFLICT(update_id) DO NOTHING`: `meta.changes=1` is fresh; `0` is confirmed duplicate.
- Operational errors, failed results or unverifiable metadata raise redacted typed `UpdateClaimUnavailable`.
- `src/routes/webhook.ts::handleWebhook()` returns HTTP 503 and `Retry-After:5` for this admission failure, so Telegram can redeliver rather than silently lose an unprocessed update.
- Existing behavior after a successful claim/handler dispatch remains unchanged. This fix is not a wholesale durable webhook queue or a claim that all unrelated handler failures are retryable.
- Existing dedupe retention and cleanup policy were not optimized in this phase.

### Evidence

Tests cover real repeated IDs, insert/cleanup/unverifiable-result errors, failed webhook admission returning 503, recovery/redelivery succeeding, and confirmed replay avoiding a second dispatch.

## 5. Full-audience automatic announcements

### Current workflow and durable state

1. An authorized administrator creates and confirms the existing announcement workflow. An unconfirmed draft is inert; cron never broadcasts drafts. Initial confirmation verifies the live admin conversation and creator.
2. Confirmation persists `started_at`, the customer-ID high-water mark, and total audience estimate. The existing eligibility is **all registered customers at confirmation**. Later joiners belong to future announcements. Existing recipient/history rows are retained.
3. A keyset cursor materializes at most 200 recipient rows at a time. Unique `(announcement_id,customer_id)` rows and cursor compare-and-set in a transaction prevent duplicate seeds. No repeated audience-wide count/scan per 20-message chunk.
4. One internal chunk claims at most 20 due recipients and sends sequentially, paced at a minimum 80 ms between broadcast attempts. It leaves time for the eight-second transport timeout.
5. The existing `*/5 * * * *` scheduled handler calls `runAnnouncementSweep()` automatically, up to two internal chunks (40 attempts) within a nominal 22-second announcement deadline. Initial/manual pass nominal budget is 18 seconds. No administrator continuation is required.
6. Counter triggers maintain recipient, confirmed sent, failed and active counts. `/announcements` shows total, sent, failed, pending, active, retryable, delayed and still-seeding work. Unseeded audience is included in pending progress.
7. Restarted Workers resume from durable cursor, recipient state, leases and retry timestamps. The scheduler skips delayed jobs and rotates ready jobs using durable update times. No new queue, Durable Object, resource or external service is required.
8. A job reaches `done` only when seeding has completed, no active claims remain, and every materialized recipient is sent or failed. `done` does **not** mean every message succeeded: failure counts remain explicit.

### Failure handling

- Confirmed positive `message_id`: sent, ID persisted.
- Invalid local recipient / Telegram 400, 403, 404: terminal failed; continue others. No unrelated customer deletion/block flag rewrite.
- Network timeout/ambiguous response or 5xx: pending delayed at least 60 seconds, capped at three failure attempts before terminal failed. Unknown failures never become sent.
- 429: honor `retry_after` in persisted recipient due time **and global broadcast pause**, leave other claimed recipients unattempted, and resume after pause. Missing/invalid retry instruction defaults to 60 seconds. Rate limiting does not burn the three-failure budget.
- 401 configuration failure: global ten-minute broadcast pause, pending recoverable recipient; do not mark the entire audience blocked.
- Worker deadline: unattempted claims released, attempted uncertain work retained until safe lease expiry.

Terminal failed recipients do not automatically retry forever; correcting blocked/invalid recipients or reviewing exhausted unknown outcomes is an operator concern. The UI retains optional progress/manual retry controls, but normal full-audience delivery no longer depends on them. Existing initial/manual-pass completion messages are retained; a cron-only completion is visible through `/announcements`, without a newly guaranteed proactive completion notice.

### Capacity and limits

The 20-recipient constant is **an internal chunk size, not an audience cap**. Tests show 75 and 2,000 recipients terminating automatically across chunks. The 2,000-recipient test uses an injected clock and mock Telegram transport, not 2,000 live messages.

The conservative schedule allows at most 40 attempts per five-minute sweep plus the initial pass. A single 2,000-user announcement therefore needs about 50 sweeps (roughly four hours, depending on initial pass, timing, latency, other jobs and retries), not one unlimited request. Multiple jobs share this capacity. High latency can reduce throughput; repeated configured-token failure can keep work paused indefinitely until corrected. Bounded work respects the existing architecture but actual Cloudflare plan/subrequest/CPU limits and total combined scheduled work need staging measurement. Eight-second sends can reduce a sweep to only a few recipients. Pacing bounds announcements only, not all other bot messages.

The deadline is cooperative, not a hard execution guarantee: individual D1 operations and unrelated existing scheduled sweeps also take time. Remote platform suspend/kill behavior has not been reproduced. Do not increase fan-out or add infrastructure without a separate reviewed task.

## Exact changed files against the 592-test baseline

### Production code / schema

- `migrations/0023_reliability_delivery.sql` — additive wallet claim/link guards and durable announcement state/counters/leases.
- `src/db/wallet.ts` — atomic payment/refund claims, stable-token reconciliation, bounded orphan reservation recovery.
- `src/db/announcements.ts` — durable dispatch/recipient claims, keyset seed, counters, retries, pacing and completion.
- `src/db/dedupe.ts` — proven conflict versus operational failure classification.
- `src/routes/webhook.ts` — retryable admission failure HTTP response.
- `src/telegram/delivery.ts` — new delivery result adapter.
- `src/telegram/api.ts` — new strict classified send method; other Telegram call behavior retained.
- `src/types.ts` — optional structured delivery method contract.
- `src/handlers/serviceMigration.ts` — stamp handoff only on confirmed send.
- `src/handlers/announcements.ts` — confirmation gate, automatic sweep, detailed progress; preserve admin workflow/completion notices.
- `src/index.ts` — wire two bounded recoveries into existing scheduled trigger.

### Tests / handoff documentation

- `tests/reliabilityRegression.test.ts` — 40 new permanent regression tests.
- `tests/reliabilitySchema.test.ts` — 4 additive upgrade/rollback/guard/conflict tests.
- `tests/walletConcurrencyConnections.test.ts` — 3 real independent SQLite-connection tests.
- `tests/helpers.ts` — apply 0023 in isolated fixture; realistic Telegram success result.
- `tests/serviceMigration.test.ts` — realistic confirmed-success response fixtures only.
- `RELIABILITY_DELIVERY_REPORT.md` — this report.
- `docs/en/reliability-delivery-release.md` — future approved release checklist.

No source changes to existing panel authorization, Mini App authentication/encryption, panel routing, pricing, migration engine/state machine, payment policy, referrals or customer entitlement logic. Migrations 0020, 0021 and 0022, Wrangler configuration, package manifests and lockfile are unchanged. Financial correctness guards/refund compensation are deliberately within the wallet repair scope.

## Migration compatibility and rollback

0023 is required before the new Worker. It adds columns, one singleton table, indexes and triggers; it does not rebuild/drop financial/customer/service tables or change customer balances/order states. Historical payment tokens and announcement counters/started evidence are backfilled. A conflicting historical token aborts migration; operator review is required, not silent merging.

Versioned Wrangler re-application is a no-op. Raw SQL is not rerunnable. Schema rollback was tested transactionally, not by deleting live schema after new-version use.

**No mixed announcement Worker versions:** the old sweep can reset active delivery claims, so a coordinated quiescent cutover is required. Pause creation/sending in the approved release window, wait for old in-flight work to drain, apply the migration, and activate the new Worker. Additive schema compatibility alone does not make the old announcement runner concurrency-safe. After new funded-order guards/announcement state are used, use a compatible forward correction; do not blindly roll back to old sweep/refund logic or drop recovery state. See the release guide.

## Remaining limitations / verification boundaries

- No live panel, Telegram, remote D1, production traffic, Cloudflare billing or dashboard state was tested.
- Local fixtures are representative, not an export of production. Review historical token ambiguity and counts/backups in a separately approved staging/release process.
- Existing historical missing ledgers/incorrect delivery stamps cannot be safely reconstructed from this forward fix alone; no automatic historical repair is attempted.
- The checkout saga is recoverable, not an all-stage single database transaction. Orphan refund capacity is two per cron; a sustained backlog requires separate reviewed sizing, not an unbounded sweep.
- Telegram's unknown accepted-send outcome may duplicate messages; no exactly-once promise. Failed announcements retain history rather than silently appear successful.
- The five-minute cron must already be present/enabled; this task made no production configuration changes. Large audiences complete slowly at the intentional cap.
- Existing dedupe post-admission semantics, unrelated notification implementations and general resource optimization remain outside scope.
- Previous authorization fixes are intact and covered by the full suite; byte preservation and unit tests are not a new external security certification.

## Artifact integrity and boundary confirmation

The delivery patch is against the exact saved 592-test local source tree. Packaging verifies `git apply --check`, applies the patch to a clean copy of that baseline, compares the complete resulting source tree byte-for-byte, and checks ZIP integrity. Dependencies, Git internals, local state, builds and private local variables are not included.

Only local implementation/test/documentation files and isolated synthetic test databases were changed. **No production data, secrets, deployments, commits, pushes or production migrations were touched.** No general optimization or release work is authorized by this delivery. Await approval before any further changes or release action.
