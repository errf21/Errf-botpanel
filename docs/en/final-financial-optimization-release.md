# Final financial correctness and measured optimization release guide

## Status and exact source

This is a future operator checklist, **not an executed deployment**. Local implementation/testing is complete; no production data, secret, migration, deployment, commit or push was touched. Obtain separate staging/release approval before any remote command or dashboard change.

Patch base: `Errf-botpanel-reliability-full-audience.zip`, **203 files / 639 tests / migrations0001–0023 /29 application tables**. Archive SHA256:
`986590c8060027facdaa20df8c09639c0189dbd270bc24a2e39c3f56a436a18c`.
The exact per-file baseline manifest is `docs/evidence/financial-optimization-baseline-sha256.json`. Its canonical sorted-JSON SHA256 is `32128cab09350cc8ae11c1b4bb374e5b7646a652347cf6b64e2a30acaf7b90bc`.
Git ancestor `348c2414dbae119b962076fed9223d3edc29970b` **alone is not the patch base**: earlier delivered local multi-panel/migration/reliability changes must be present. Extract the named archive, enter its `Errf-botpanel` directory, then check/apply the patch locally:

```sh
git apply --check /path/to/Errf-botpanel-financial-optimization-from-639.patch
git apply /path/to/Errf-botpanel-financial-optimization-from-639.patch
```

The final ZIP contains the full source, existing features/tests,0024, this checklist, the implementation report and evidence. No dependency versions or Worker configuration templates were changed.

## Exact Cloudflare inventory

“Existing” means already required/present in source, **not verified on production**. This release adds **no secret, variable, resource, product, domain, queue, per-panel binding or extra cron**.

| Setting | Type and exact destination | Operator action after approval |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret: Workers & Pages → intended `errf-botpanel` environment → Settings → Variables and Secrets | Preserve valid existing token. Never paste into source/chat. Missing,empty,whitespace token still fails Mini App authentication closed. |
| `TELEGRAM_WEBHOOK_SECRET` | Secret: same Worker → Variables and Secrets | Preserve exact existing value and Telegram webhook `X-Telegram-Bot-Api-Secret-Token` header. |
| `PASARGUARD_API_KEY` | Secret: same Worker → Variables and Secrets | Preserve original legacy panel's working key unchanged. No rotation/replacement required. |
| `PANEL_ENCRYPTION_KEY` | Secret: same Worker → Variables and Secrets | Preserve existing base64-encoded32 random-byte AES-GCM master key. Replacing it would make existing D1 ciphertext unreadable. Back up independently from D1 with restricted access. |
| `PAYMENT_CARD_NUMBER` | Secret: same Worker → Variables and Secrets | Existing card-payment instruction requirement; preserve if card payments are used. Not a new optimization requirement. |
| `PASARGUARD_PANEL_URL` | Text variable: same Worker → Variables and Secrets; reconcile `wrangler.jsonc.vars` | Preserve the original legacy public HTTPS origin. Do not repoint to switch panels; use `/panels`. |
| `ADMIN_CHAT_ID` | Text variable: same Worker → Variables and Secrets / reviewed Wrangler config | Explicit positive numeric Telegram **user** ID, not group/chat username. Checked-in value is empty; do not deploy that over the intended allowlist. |
| `PANEL_ADMIN_IDS` | Optional text variable: same Worker → Variables and Secrets | Comma-separated additional positive numeric administrator IDs. Union with `ADMIN_CHAT_ID` for panels and migrations. `customers.is_admin` alone NEVER grants panel/migration rights. Preserve current explicit list. |
| `PANEL_ADMIN_ORIGIN` | Text variable required for panel Mini App configuration: same Worker → Variables and Secrets | Exact intended public HTTPS Worker/custom-domain origin, no path/query/credentials/non443port. Request URL and POST Origin must match; origin/nonce possession is NOT authentication. Preserve existing domain/origin. |
| `SUPPORT_CONTACT` | Optional text variable: same Worker → Variables and Secrets | Existing plain Telegram handle, not URL/secret; preserve if used. |
| `DB` | Workers & Pages → Worker → Settings → Bindings → D1 binding named `DB` | Preserve intended existing `telbot-db` database/environment. Confirm the real database ID; do not copy a stale/sample target or create/replace production DB. |
| `*/5 * * * *` | Existing Worker → Settings → Trigger Events → Cron Triggers; `wrangler.jsonc.triggers.crons` | Preserve/restore after coordinated cutover. Continues announcements, recovery, notification/reminder sweeps and dedupe housekeeping. Authorization-token garbage collection runs hourly through this same trigger. |
| Domain/routes | Worker → Settings → Domains & Routes | Preserve HTTPS origin, `/telegram/webhook`, `/health`, `/admin/panels`, `/admin/panels/metadata`, `/admin/panels/configure`. No new endpoint. |
| Compatibility/config | Existing `wrangler.jsonc` | Preserve `nodejs_compat`, compatibility date,observability,keep_vars and intended bindings. Declared vars can override dashboard values; review actual resolved config before release. |

A new isolated environment without an encryption key can generate one **on a trusted operator computer** using `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`, then enter it as a Worker Secret using the dashboard or `wrangler secret put PANEL_ENCRYPTION_KEY`. Do not run this to replace an existing key, publish its output, store it in D1, or commit it. Existing authorized panels' API keys are entered only through the authenticated Telegram HTTPS Mini App, stored as AES-GCM ciphertext in D1. No username/password, bearer-token or login credentials are needed. There are no new optimization/backoff/announcement enable flags.

## Schema and deployment order

1. Apply existing versioned migrations **0001 through0023 in filename order** if not already tracked. Never rewrite released migrations.0023 is required for stable wallet payment tokens, announcement leases/counters and durable full-audience delivery.
2. Apply new **`0024_financial_optimization.sql` after0023 and before activating this Worker**. It adds wallet mutation intent uniqueness, referral ledger linkage, truthful top-up credit status, measured nonunique recovery/refund indexes, durable migration backoff fields and due index.29 application tables remain; no historical records/balances/identities are deleted/repaired.
3. Use the versioned migration ledger. **Raw SQL0024 is not independently repeatable** (ALTER columns); a tracked Wrangler repeat is a no-op. SQL transaction rollback/raw-repeat integrity and local Wrangler fresh/upgrade/repeat were tested. Do not execute raw SQL twice or manually fake migration ledger entries.
4. Historical approved topups become `credit_status='review_required'`, whether or not a ledger exists. The old cap bug means approval/ledger alone cannot prove actual credit. Existing balances/ledger/status remain unchanged. Do not automatically re-credit historical approvals or invent missing ledgers. Review independently under separate authorization. Historical referral anchors remain once-only, even with no ledger link. The release prevents new inconsistencies, not retroactive compensation.

### Controlled future cutover

- Approve staging first with isolated Worker/D1 and synthetic Telegram/panel credentials. Verify backups and tested restore, separately preserving encryption key. No production metrics/data were obtained for this task.
- Coordinate a maintenance window for financial actions, new announcement starts/manual broadcast callbacks, provisioning/migration writes, incoming webhooks and cron. There is **no new in-code maintenance flag**. Use an explicitly approved operational traffic/trigger procedure; stopping cron alone does not stop webhook/manual work.
- Drain/confirm all in-flight old handlers and leases before the schema/code switch. Do not use mixed old/new weighted routing for money operations: the old mutation code does not use the new intent guards and retains the reproduced bugs. Do not overlap unsafe pre0023 announcement runners with owner-bound delivery. Even though the immediate639-test predecessor is lease-aware, this release procedure requires a quiescent single-version cutover rather than claiming rolling financial compatibility.
- Confirm the intended database/environment, apply only outstanding versioned migrations, verify success/FKs/record preservation in the approved environment, then activate the reviewed complete Worker version at100%. Remote migration and deployment commands require separate authorization; none were executed here.
- Restore the existing five-minute cron and webhook traffic. Check Telegram's pending-update retention before planning downtime; do not discard pending updates or reset dedupe history as a release shortcut. Keep the same bot identity/update intent namespace.
- No Queue,Durable Object,R2,external service or extra Cron is required. Existing full-audience announcements remain bounded: up to20 per chunk and up to2 chunks per scheduled pass, with pacing/deadlines and rate-limit pauses. They are eventual, not an arbitrarily large one-request broadcast.

## Post-deployment verification (staging, then approved production observation)

- `/health` and actual cron invocations: health alone does not prove panel connectivity/delivery. Confirm the five-minute schedule and aggregate scheduled CPU/subrequests against the intended Cloudflare plan.
- Valid webhook secret accepted; invalid/missing rejected. Mini App GET shell contains no metadata; POST metadata/configuration requires fresh signed initData,current allowlist,Origin,session ownership. Blank bot token fails closed; ordinary DB admins cannot manage panels/migrations. Nonce consume/replay/concurrent duplicate protections unchanged.
- Legacy key/origin unchanged; add/test/select3 synthetic panels, create on default, retry on originally assigned panel after default switch, operate migrated/current/original services correctly, no cross-panel fallback.
- Inject ledger/anchor/balance failures in staging: no partial wallet mutation/reward/topup credit. Same stable admin intent applies once; concurrent independent intents produce both ledgers. Topup cap rejection records blocked/uncredited—not success/credit ledger. `/topups` exposes approved uncredited/blocked retries; retry only after resolving cap/error and never charges another payment. Historical review-required records need separate audit.
- Migration blocked recovery: repeated identical blocks retain first/last/count, back off durably to a maximum hour, exclude delayed/revoked-operator work from the2-job budget; explicit administrator retry remains available. All remote identity/reconciliation/revocation guards retained. Customer handoff only stamps confirmed Telegram delivery; unknown acceptance is still at-least-once.
- Run a synthetic75/2000-recipient announcement across multiple cron invocations without repeated administrator taps. Observe accurate sent/failed/pending/active/retryable/delayed,seeding,lease recovery,429pause and blocked recipients. Preserve recipient history/counters. Crashes after Telegram acceptance may duplicate delivery after lease recovery; no exactly-once guarantee.
- Compare financial/customer/order/migration/announcement evidence before/after representative staging operations. Ensure the new partial indexes improve actual D1 rows_read without excessive write/storage overhead.
- Observe bounded expiry maintenance: minimum48-hour dedupe horizon;1000expired update IDs per cron. Panel/admin-choice cleanup200/table hourly with10-minute maintenance grace; admin-action cleanup200/hour with15-minute grace. Existing lazy expiry cleanup remains; grace is not an authorization extension. High ingestion can outpace cleanup; monitor backlog rather than shortening replay protection.

## Rollback

Prefer a compatible forward fix or pause affected operations. The0024 additive schema must stay after use; do not drop intent keys,ledger links,credit status,backoff state,indexes or migration evidence as an emergency rollback. Do not restore an old D1 backup over newer legitimate money/service/delivery writes.

The639-test Worker may read additive columns but would reintroduce known financial bugs and ignore new mutation/recovery semantics. It is **not a safe unrestricted rollback** for financial traffic. Never roll back to pre0023 delivery code. Any compatible rollback needs a quiescent window,financial review,and preservation of all current identities/ledgers/no-resend evidence. Index-only reversal is possible later without deleting business data but must be separately justified and versioned.

## Measurements after separately approved release

Collect matched7–14day windows: Worker inbound requests,scheduled invocations,CPU and duration quantiles,errors,subrequests; D1 rows_read/rows_written/query timings/database storage; logging event volume; announcement backlog/retry-after/lease age/success/failure; migration due/backoff/blocked count/revocation uncertainty; panel call volume/latency/status and trial overlap; dedupe backlog/arrival rate; wallet/topup/referral consistency exceptions. Do not infer billing savings from local SQLite milliseconds or physical pages. See the implementation report/evidence for measured local results and deferred policy-dependent proposals.

Stop for separate release approval. This checklist is not permission to deploy.
