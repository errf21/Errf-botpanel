# Financial correctness and measured optimization — final implementation report

## Outcome and verification scope

**Implemented on the exact delivered203-file /639-test baseline. Final local suite:680 passing tests, zero failures, zero cancellations and zero skips;41 new tests.** TypeScript and Worker dry-run build pass. Fresh local D1 install,0023→0024 upgrade,versioned repeat-noop,transactional rollback/raw-repeat rejection and foreign-key checks pass.29 application tables remain.

This is local release preparation, **not a deployed release or a production-security/performance certification**. No production query,data,secret,configuration,migration,deployment,commit,push or dependency install/upgrade occurred. No new Cloudflare product or external service was added. The named prior source archive was verified byte-for-byte before editing; the baseline test suite,typecheck and dry-run build were executed before changes.

## Exact baseline and patch

- Base archive:`Errf-botpanel-reliability-full-audience.zip`.
- Base archive SHA256:`986590c8060027facdaa20df8c09639c0189dbd270bc24a2e39c3f56a436a18c`.
-203-file manifest canonical sorted-JSON SHA256:`32128cab09350cc8ae11c1b4bb374e5b7646a652347cf6b64e2a30acaf7b90bc`; every filename/hash is included in `docs/evidence/financial-optimization-baseline-sha256.json`.
- Git ancestor:`348c2414dbae119b962076fed9223d3edc29970b`. **Vanilla GitHub HEAD is not a valid base.** The previous delivered multi-panel,authorization,subscription migration and reliability changes must be present.
- Final source ZIP and unified `.patch` are separate genuine artifacts. The patch is generated only from actual differences against that exact203-file tree. Verification includes `git apply --check`, applying to an isolated baseline copy,matching every resulting file byte-for-byte with final source,and ZIP CRC/file-set/byte equality. No commit is created for this process.

## Three financial defects: root cause and fix

### A — Administrative wallet mutation

`src/db/wallet.ts::applyWalletMutation` previously committed the balance UPDATE before the ledger insertion. An injected ledger failure left an unrecorded balance change. The replacement inserts a uniquely keyed ledger claim from the authoritative current balance and applies the balance effect only for THIS newly generated claim, in a single atomic D1batch. Amount,owner,actor,kind,order identity and bounds are checked; retries reconcile the same stable intent instead of inferring success from balance.

`src/dispatch.ts` carries the verified Telegram update ID to `UpdateContext`; `src/handlers/wallet.ts::applyWalletAdminAction` creates `telegram-wallet:<actor>:<updateId>`. Distinct updates remain distinct intentions; replay of the same intention cannot apply twice. Direct internal callers without an operation key explicitly create a NEW intention; they cannot claim cross-call retry idempotency without supplying a stable key. The pre-existing payment/refund/checkout guards were not simplified.

Permanent tests inject ledger and balance failures,assert complete rollback,retry same key,substitute owner/amount/actor,and reconcile response loss after commit. Independent SQLite threads/connections prove same-key and distinct-key concurrency preserve balance and all ledgers.

### B — Referral reward

`src/db/referrals.ts::maybePayReferralReward` previously wrote the reward anchor and credit before the ledger. Failure could strand a reward without accounting. Eligibility,self-referral exclusion,lifetime referrer cap,balance bound,ledger,referral anchor and credit now share one transaction. The ledger operation identity is once-per-referee; the reward anchor links the exact ledger claim. Only the winning claim returns a payout notification result. Percent/floor,first-touch and configured reward rules remain in existing callers/config; no financial history is rewritten.

Ledger,anchor and balance failure tests show zero partial effects; same-referee concurrent calls pay once; different referees competing for a one-reward cap pay at most one. Historical anchors with absent ledger linkage remain once-only and are NOT automatically re-paid. If a response is lost after committed batch,the current claim is reconciled. A rejected cap/failed transaction leaves no speculative anchor/credit; eligibility remains available for an authorized recovery attempt.

### C — Top-up balance cap

`src/db/topups.ts::creditTopupOnce` previously guarded only the balance UPDATE; its independent ledger INSERT could still record a45000credit and return success when the cap refused the actual credit. The new transactional claim requires the exact approved topup,owner,amount,eligible credit status and available balance room. Balance effect,ledger and `credit_status='credited'` are committed together. Cap rejection returns false,creates no credit ledger and records `blocked/balance_cap`. Partial credits are not introduced.

Payment approval remains a durable separate review decision; `credit_status` makes its monetary outcome explicit. An interruption between approval and credit leaves `uncredited`,not an invented success. `/topups` includes approved uncredited/blocked records for authorized retry; customer/admin output clearly states credit NOT applied. The review result's `ok` describes approval,while `credited` describes the wallet effect; user-visible credit success is gated by the latter. Retry does not solicit/create a new payment. Below/exactly/above-cap cases,owner/amount substitution,SQL failure,retries,uncertain committed responses and competing cap-limited topups are tested.

**Historic-data limitation:**0024 marks pre-existing approved topups `review_required`,preserving every old column,row,balance and ledger. An old ledger cannot prove a real credit because of the original bug. No speculative repair,re-credit or deletion is performed. Historical referral anchors likewise retain their existing once-only role. Separate independently evidenced financial review is necessary for existing anomalies.

## Implemented optimizations and safeguards

| Audit finding / priority | Exact files/functions | Change and preserved safety |
|---|---|---|
|F01/P1|`src/panels/registry.ts::observationWriter`|Targeted disjoint original/current identity branches use existing indexes instead of the broad effective view. Historical source is excluded after migration. An observation is inserted only when exactly one eligible identity matches. Owner,panel,remote ID,username,origin and provenance retained. No observation history deleted.|
|F02/P1|`src/db/wallet.ts::recoverUnlinkedWalletPayments`,0024indexes|Measured nonunique ordered candidate and refund-lookup partial indexes; exact guard SQL and atomic refund behavior unchanged. Order ID/payment token/cutoff/funded-order and late-order compensation protections retained.|
|F03/P1|`src/handlers/serviceNotifications.ts::runServiceNotificationSweep`|One fresh panel read serves both independently eligible trial notice decisions in one held service lease. Separate budgets,kinds,claims,backoffs and paid pools retained. No reuse after lease release,next run,mutation or migration generation.|
|F04/P1|`src/db/orders.ts::claimOrderForProvisioning`|Return the validated post-claim row after claim-token ownership check; remove only the immediately duplicated SELECT. Pre-claim row never substituted.|
|F04/P1|`src/provision/provision.ts::provisionOrder`|Consult default selection only for unassigned NEW provisioning. Assigned retries and original-service lifecycle resolve durable ownership. Unassigned claim still validates current selection revision atomically; no fallback.|
|F05/P1|`src/db/customers.ts::upsertCustomer`,`src/admin.ts::resolveIsAdmin`,`src/dispatch.ts`|Read general-admin flag with same-request customer identity,avoiding an extra SELECT. Explicit panel-admin allowlist untouched; no client value/cross-request auth cache.|
|F08/P2|`src/migrations/service.ts::state,advanceMigration,recoverServiceMigrations`,0024|Repeated identical blocks retain first-change timestamp,last-observation time,count and reason; coalesce duplicate blocked events only. Persist bounded exponential due time,up to1hour. Exclude delayed and revoked-operator rows before the2-job limit; preserve manual retry and every significant transition/create/revoke event. No automatic destructive revocation or completion.|
|F06/P2|`src/db/dedupe.ts::claimUpdate,cleanupExpiredUpdates`,`src/dispatch.ts`,`src/index.ts`|Dispatcher omits per-update cleanup; existing five-minute cron deletes at most1000IDs older than48hours. Direct helper callers retain legacy pruning behavior. INSERT/error/unverified-result failures remain typed operational errors,not duplicates.|
|F11/P2|`src/db/announcements.ts::runAnnouncementChunk,listRecentAnnouncementProgress`,`src/handlers/announcements.ts::runPass,showAnnouncements,runAnnouncementSweep`|Skip two established-boundary no-op writes,remove duplicate settle/reload,one bounded five-job progress query,short-circuit paused/owned sweeps in selection. Atomic dispatch/recipient ownership remains final authority. No recipient history removed and no per-recipient rate/lease/pacing checks optimized away.|
|Temporary cleanup|`src/db/maintenance.ts::cleanupExpiredAdminTokens`,`src/index.ts`|Hourly bounded expiry of authorization-only panel sessions,migration choice nonces and admin-action rows through existing cron. Never deletes service,migration,ledger,history or conversation/recovery evidence. Current expiry checked inside SQL batch; grace is not extended authorization.|
|Admin miss/rearm|`src/db/admin_actions.ts::getPendingAdminAction`|A missing row no longer issues a blind DELETE that could erase a concurrent new action. Expired cleanup rechecks current expiry. Freshly armed action survives stale cleanup.|
|F15low-risk subset|`src/telegram/api.ts::call`|Bounded method/numeric status log only; raw upstream description/error-code strings never logged. Existing benign edit classification and delivery semantics unchanged. New structured announcement/migration transport untouched.|

## Durable migration backoff

New fields:`blocked_count`,`next_recovery_at`,`last_recovery_at`. First observation of a block permits immediate reconciliation. A repeated identical block starts60seconds of delay; subsequent repeats double up to3600000ms. The five-minute cron controls actual retry granularity. On changed reason/state a meaningful event is recorded and repeated-block count resets; success clears the due block. Identical repeated blocks do not rewrite the first-change timestamp or append identical audit events; counter and last-observation timestamp remain durable.

Both before and after taking the service lease,automatic advancement checks persisted due time. Manual authorized advancement bypasses due time but not authorization,identity,lock,entitlement,origin,operation supersession or reconciliation checks. Delayed rows cannot occupy the cron limit; removed operators are filtered before limiting and every attempted execution still authorizes. Durable fields survive Worker restarts. Cleanup-pending/source-revocation status is not reinterpreted as completed; source revocation remains explicit and independently verified.

## Announcement invariants

The internal20-recipient chunk is NOT a total audience limit. Confirmation freezes a durable audience boundary; keyset seeding,counters and existing five-minute continuation eventually process all captured eligible recipients. Each cron runs at most two bounded chunks with deadlines,pacing,owner-bound global/recipient leases,retry-after pauses and truthful terminal accounting.75- and2000-recipient regression tests,overlapping owners,restart recovery,deadline release,429,blocked recipients,unknown acceptance,failed booking and fairness remain in the full suite.

No new success is inferred from void/failed sends. Migration handoff recovery likewise retains its prior confirmed-delivery fix. Telegram has no idempotency key: a crash after acceptance before persistence can later duplicate a message,but cannot create a second service/charge through these paths. At-least-once uncertainty is documented,not described as exactly-once. No automatic default-panel fallback or automatic source revocation was added.

## Before/after measurements

Independent comparable fixtures use actual exported functions,real SQLite D1shim and mocked external responses. SQL counts are statements,not network billing/read-unit counts. Source and generated query plans are preserved in `docs/evidence/financial-optimization-measurements.json`. Local warm timings are not Worker CPU,remote D1 latency or production savings.

| Fixture/path |Before|After|What this proves |
|---|---:|---:|---|
|Ordinary existing `/myid` update|5SQL|3SQL|One expired-dedupe DELETE and one admin SELECT removed per fresh update. Customer profile UPSERT remains.|
|Empty non-hourly scheduled run|15SQL|16SQL|One bounded dedupe cleanup moved to cron; optimization shifts work rather than claiming all cron SQL falls. Hourly admin-token cleanup adds3statements on that run.|
|First20-recipient announcement chunk|115SQL|113SQL|Two boundary initialization no-op writes skipped.20mocked Telegram sends unchanged.|
|Steady20-recipient chunk|112SQL|110SQL|Same2writes avoided; recipient ownership/pacing/retry state preserved.|
|Paused announcement sweep|3SQL,0sends|1SQL,0sends|Selection checks shared pause/lease; no pointless dispatch UPDATE/release.|
|Five-job announcement status|6SQL|1SQL|No per-job round-trip aggregation; pending subqueries remain indexed and are NOT eliminated work.|
|Successful provisioning claim helper|5SQL/3identityreads|4SQL/2identityreads|Validated post-claim row reused,not pre-claim data.|
|One trial below both thresholds|2panelGETs/2observations|1panelGET/1observation|Only redundant same-lock verified snapshot removed; next sweep re-reads fresh.|

SQLite fixture:2000customers,10000orders,200migrated resources,20pending migrations,20000observations,10000wallet entries,2000announcement recipients. `ANALYZE`,five warm SELECT repetitions; identical fixture construction before/after.

| Query |Before median ms|After median ms|Plan evidence |
|---|---:|---:|---|
|Verified observation identity|2.0127|0.0068|Broad completed-order/view work replaced by indexed base/current branches; exact-one-match guard retained.|
|Wallet recovery all-orphan stress|4250.557|0.0055|Ordered payment candidates plus indexed refund anti-join avoid repeated broad scans/sort. Stress distribution intentionally pathological,not production.|
|Wallet mostly linked history/two reservations|5.7364|0.0041|Same guards/returned limit2; index benefit reproduced on linked fixture too.|

The final recovery-due query uses `idx_migration_recovery_due` instead of the old historical scan/temp sort in this fixture. Query plans and returned-row counts are recorded; **actual rows examined/billed D1 rows_read were not measured**. The measured SELECTs returned1 observation identity and2 wallet candidates; LIMIT does not by itself prove only2rows scanned.

Index overhead in the synthetic SQLite `dbstat` fixture: ordered wallet candidate index442368bytes/108pages; refund lookup,operation-key and migration-due indexes4096bytes/1page each. Empty referral/intent/refund distributions understate their future index size. These are local physical pages,not Cloudflare database billing. New intent/link/status/backoff fields and guards add writes/storage needed for correctness. No percentage or dollar savings claimed. With an enabled5minute schedule there are288scheduled times/day; hourly token maintenance adds72statements/day and dedupe288/day under one invocation per slot. This is a code-based cadence estimate,not measured production activity. High update volume can exceed the1000-per-sweep cleanup capacity; retain48-hour protection and measure backlog before changing budget.

## Validation executed

- Before edits:639/639tests,0fail/skip; TypeScript and Wrangler dry-run PASS; exact203file baseline/archive match.
- Final:680/680tests,0fail/skip/cancel; TypeScript PASS; Wrangler4.131.1dry-run PASS (814.81KiB /159.58KiBgzip,build estimate only),no deployment.
- Three new permanent test files:`financialOptimization.test.ts`,`financialOptimizationConnections.test.ts`,`financialOptimizationSchema.test.ts`; additional scoped routing/notification and migration recovery tests in existing files.
- Two old assertions explicitly requiring duplicate trial polling were tightened to exactly1fresh read,as required by the authorized optimization. Routing,notification,backoff and service-integrity assertions remain. No existing test cases were deleted,disabled or skipped.
- SQL triggers inject actual ledger,balance,anchor/status failures and verify transaction rollback; simulated lost committed responses reconcile without duplicate effects.
- Six NEW independent SQLite worker-thread/connection scenarios: same/different admin intent,same-referee/lifetime-cap referral,duplicate/cap-competing topups. Three prior independent wallet-payment scenarios retained. These are actual SQLite transactions,not mocked balances; **Cloudflare distributed D1 execution is not tested**.
- Local Wrangler fresh0001–0024 and copied0023→0024 upgrade PASS; tracked repeat no-op PASS;29 application tables and all original columns/records preserved; zero FK violations. Unit migration rollback/raw-repeat failure PASS. Fixture includes legacy,multi-panel and migrated current-resource identity; representative synthetic evidence is not a proof for unseen production rows.
- Protected files remain byte-identical to203baseline:`src/panels/admin.ts`,`src/panels/security.ts`,`tests/panelAuthorization.test.ts`,`src/routes/webhook.ts`,`src/handlers/serviceMigration.ts`,`src/panels/recovery.ts`,`tests/reliabilityRegression.test.ts`,all released0001–0023migrations,package files and Wrangler config. Thus previous authenticated metadata/fail-closed bot-token/nonce/session/replay fixes and confirmed handoff/announcement ownership/dedupe-failure regressions are retained and executed.
- Final patch/ZIP integrity verification described above is part of handoff,not a hypothetical future check.

## Remaining limitations and explicitly deferred audit proposals

1. **No live PasarGuard,Telegram,Cloudflare distributed D1,production analytics/billing/security penetration or production data safety test.** API behavior is mocked; staging must verify actual version,permissions,limits,latency,rate control and partial-failure semantics.
2. Historical cap/unrecorded reward/wallet anomalies are not reconstructed,repaid or deleted. Approved legacy topups require independent review. No speculative customer-entitlement change.
3. Conditional profile writes were NOT implemented: audit could not establish whether `updated_at` activity semantics may change. Timestamp consumers/unchanged-profile ratios require policy and measurements first.
4. Broad notification/recovery due-queue redesign,append-only observation compaction/business-history archival,conversation/recovery record cleanup and index removal were NOT implemented: equivalence/retention/index-workload evidence was insufficient. Existing uniqueness/renewal indexes retained; rejected base expiry-index shortcut was not added.
5. Handoff-notice backoff and generalized old Telegram transport timeout/retry redesign are deferred: separate delivery/fairness/rate-limit behavior needs a dedicated design/test gate. Existing confirmed handoff stamp remains correct/recoverable,at-least-once; repeated failures can still produce scheduled sends. Only repeated **service-state** blocked recovery gets new backoff here.
6. Per-recipient announcement pacing/claim redesign,unbounded parallelism,larger fan-out,cron changes,Queues/Durable Objects/R2/new products were not introduced. Complete audience still progresses at bounded throughput; actual plan budget must be measured.
7. Expired authorization-token garbage collection is bounded,not a guarantee against arbitrary ingestion/backlog. Grace affects scheduled housekeeping,not validity; existing read/lazy cleanup may remove expired rows earlier. No active token is deleted by maintenance predicates. Conversation states,service locks and recovery evidence are deliberately retained.
8. Legacy non-migrated username-mutation/404 identity assumptions documented in earlier audits were not advertised as universally fixed. Migration origin/stable-ID/global-absence guards and all existing regression tests remain. No new shortcut infers absence from auth/network failure.

## Required production metrics later (no access taken now)

Collect matched7–14day before/after windows and separate request/cron traffic mix:
- Worker HTTP requests versus scheduled invocations; CPU/duration p50/p95/p99,max; errors/timeouts/subrequest counts/log volume.
- D1 database storage,query duration,rows_read and rows_written (not just statement count),recovery candidate counts/ages,SQL distributions,index write/storage overhead.
- Expired dedupe backlog and fresh-update arrivals versus cleanup capacity; expired token counts and maintenance duration.
- Panel GET/write call counts/latency/status by operation/panel; overlap of trial decisions and observation append rates/JSON size.
- Migration block count/reason,nextdue/fairness/age,manual attempts,source-revocation uncertainty and customer-notice retries.
- Announcement captured audience,seeding progress,delivery success/permanent failure/retryable/unknown/429pause,lease age,processing latency and terminal counters.
- Financial consistency alerts and independently reviewed historic anomalies; no destructive diagnostic cleanup.

Reducing stored bytes does not necessarily reduce requests,CPU or every billing category. The implemented indexes increase storage/write overhead while reducing measured query work. Shifting housekeeping from webhooks to cron improves hot-path latency but adds scheduled work. No fabricated production counts,savings percentages,billing amounts or absolute cost forecast.

## Changed-file report

All differences below are against the exact203-file delivered baseline,not vanilla HEAD. Existing files not listed are preserved. Evidence/documents are intentionally included in the final source.

- `FINANCIAL_OPTIMIZATION_REPORT.md`
- `docs/en/final-financial-optimization-release.md`
- `docs/evidence/financial-optimization-baseline-sha256.json`
- `docs/evidence/financial-optimization-local-d1.json`
- `docs/evidence/financial-optimization-measurements.json`
- `docs/evidence/financial-optimization-validation.txt`
- `migrations/0024_financial_optimization.sql`
- `src/admin.ts`
- `src/db/admin_actions.ts`
- `src/db/announcements.ts`
- `src/db/customers.ts`
- `src/db/dedupe.ts`
- `src/db/maintenance.ts`
- `src/db/orders.ts`
- `src/db/referrals.ts`
- `src/db/topups.ts`
- `src/db/wallet.ts`
- `src/dispatch.ts`
- `src/handlers/announcements.ts`
- `src/handlers/serviceNotifications.ts`
- `src/handlers/topup.ts`
- `src/handlers/topupAdmin.ts`
- `src/handlers/wallet.ts`
- `src/index.ts`
- `src/migrations/service.ts`
- `src/panels/registry.ts`
- `src/provision/provision.ts`
- `src/telegram/api.ts`
- `src/types.ts`
- `tests/financialOptimization.test.ts`
- `tests/financialOptimizationConnections.test.ts`
- `tests/financialOptimizationSchema.test.ts`
- `tests/helpers.ts`
- `tests/multiPanel.test.ts`
- `tests/phase15.test.ts`
- `tests/serviceMigration.test.ts`

Final complete source file count: **214**. Changed/new files: **36**. Refer to `docs/en/final-financial-optimization-release.md` for exact secrets/plain vars,migration ordering,quiescent cutover,post-deployment verification and rollback limitations.

Implementation and verification stop at local handoff. **Await separate explicit approval before staging deployment,release,production changes or further optimization.**
