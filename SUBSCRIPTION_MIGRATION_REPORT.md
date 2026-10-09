# Subscription migration — implementation and validation report

## Outcome and baseline

Implemented an administrator-only, recoverable service migration workflow on the exact local **529-test** audited multi-panel baseline. This is a **controlled-staging release candidate**, not a production deployment or a claim of live-panel certification.

Final full suite: **592 passed, 0 failed, 0 skipped**. This is the original 529 tests plus **60 migration tests and 3 schema tests**. Existing authorization regressions and the five prior workflow/recovery fixes were retained. No dependencies were installed/upgraded; no commit, push, deployment, production secret write or production migration was performed.

The full ZIP includes the earlier multi-panel implementation and authorization fixes, not vanilla GitHub HEAD. The incremental patch is against the saved 529-test working tree `/data/errf-subscription-529-baseline` (189 project files), not upstream HEAD. An upstream-only checkout is not a suitable patch baseline. The delivery contains 196 project files, excluding `.git`, dependencies, generated builds, local databases and actual `.dev.vars` secrets. Retained historical reports describe prior stages and do not override this report.

## Requirement-by-requirement result

| Requirement | Result | Actual evidence / qualification |
|---|---|---|
| Admin selects customer/service, destination, preview and confirmation | PASS locally | `migrationCommand`, `destinations`, `card`, `migrationCallback` in `src/handlers/serviceMigration.ts`; private chat and strict allowlist; destination pagination and durable choices. |
| Server-side authorization on every sensitive migration action | PASS locally | Engine `authorize` in `src/migrations/service.ts`; allowlist checks in all exported admin actions; webhook remains authenticated; no new browser/API migration endpoint. Forged callbacks, ordinary/D1-only admins and empty allowlist tested. |
| Fresh/saved/manual entitlement with provenance | PASS for supported finite model | `proposeMigration`, `entitlement`, `manualEntitlement`, `confirmMigration`; same absolute expiry, exact positive remaining bytes, device limit, origin/identity/timestamp evidence. Stale/manual explicitly confirmed. |
| No invented usage or silent unsupported-plan conversion | PASS locally | Invalid/unknown/exhausted/unlimited/relative/periodic/next-plan data blocks automatic transfer. Manual data must be explicitly justified by operator; not independently provable offline. |
| Accurate conservation during ongoing source traffic | LIMITED | No distributed usage-transfer primitive. Source may consume after final read or remain usable while cleanup is pending. Strict conservation requires operator quiescence; UI and release guide warn explicitly. |
| Destination created and verified before active association changes | PASS locally | `advanceMigration`: attempt persisted before POST, deterministic username/note, strict identity/quota/expiry/hwid/URL checks, disabled staging then separate activation and atomic D1 binding. |
| API-key only / no credential disclosure | PASS locally | Existing `resolvePanel`/`clientFor` and `X-Api-Key`; existing encrypted registry unchanged. Synthetic credential containment tests inspect database payloads, errors and UI. No production logging/secrets inspected. |
| Original service survives destination failure | PASS locally | Active binding remains source through `review`, `creating`, `verified`, and unsuccessful `activating`; reconciled retry, fenced abort; tests cover outages/unknown create. |
| Financial/customer/history preservation | PASS on local fixtures and code paths | No new purchase/payment/wallet operation in migration engine. Raw original purchase, payment reference, receipt, wallet/referral/usage events retained; effective view supplies current resource. Production export not examined. |
| Offline-source migration | PASS locally, operator responsibility | Trusted prior verified snapshot or explicit manual values; unconfirmed source revocation remains visible. No fabricated remaining quota from purchase price. |
| Durable state machine / duplicate and restart protection | PASS locally | Unique pre-cutover migration, durable attempts/identity, service lease/fence, transactional binding switch, unknown-outcome reconciliation, callback one-use choices. Mock failures/interruption tested; production-scale load unverified. |
| Correct routing after cutover | PASS locally | `effective_orders`, `resolveServicePanel`, existing renewal/repurchase/reset/status/delete/notification/recovery integration; migrated resources retain stable-ID and captured-origin checks even on legacy destination. |
| No cross-panel fallback / default unaffected | PASS locally | Migration resolves explicit source/destination only. Global provisioning selection is not changed. Tests cover third panel, default switches, new unrelated orders and second migration. |
| Source revocation accurately reported | PASS locally with scope prerequisite | Read/delete/read by captured ID; owner/ALL-user read required for certified absence. OWN-scope invisibility, unavailable/API errors and unknown outcomes remain unconfirmed. No automatic cron source deletion. |
| Safe abort / no orphan silently declared cleaned | PASS locally with scope prerequisite | Durable abort flag; inspect owned unpublished candidate before DELETE; verified global absence before cancellation; interrupted cleanup never auto-activates. |
| Schema upgrade / records and relationships preserved | PASS on representative local fixtures | Additive 0022; 14 pre-existing tables unchanged, zero foreign-key violations, current-view activation, transactional rollback and raw-repeat safety tested. Wrangler repeat is a no-op. Not production-data certification. |
| Panel deletion/origin editing preserves history | PASS locally | FK/SQL triggers and existing panel-management SQL guards include migration/resources/observations. Keys/names may rotate; captured origins cannot be repointed through UI for historical panels. |
| Previous Mini App authorization fixes intact | PASS locally | `src/panels/security.ts` and authorization tests byte-identical to 529 baseline; 15 authorization regressions rerun. `admin.ts` changes confined to historical-reference guards. |
| Live panel compatibility/mobile Telegram UX/Cloudflare production readiness | NOT VERIFIED | Public source inspected and mocks/local D1 executed; no live panel access, production export/credentials, real Telegram client or authenticated Cloudflare dashboard test. |

## Actual data flow and integration

### New administrator workflow

`src/handlers/commands.ts` routes `/migrate`; `src/handlers/callbacks.ts` routes validated `sm:*` data (`src/lib/validate.ts`). The workflow is private-chat-only. All mutable destination/revocation/abort choices are stored with actor, service/customer, expiry and random nonce, then consumed with one `DELETE ... RETURNING` conditioned on actor/action/time. Initial entitlement confirmation is operator-owned and performs a conditional `review -> creating` transition. A duplicate callback cannot perform an independent second migration/create. Other currently authorized admins can review/recover a committed migration; the original draft confirmation belongs to its creator.

1. `/migrate <customer Telegram user ID>` selects a completed customer service (latest ten; known ID supported).
2. Choose an enabled tested destination from pages of five.
3. Read exact customer/source/destination identity, groups and entitlement provenance.
4. If needed, `/migrate manual <migration ID> <remaining_bytes> <UTC ISO expiry> <devices>` sets non-secret explicitly reviewed values and regenerates confirmation.
5. Confirm preview; review progress, retry reconciliation, or abort before cutover.
6. After cutover, review and separately confirm source revocation.
7. Customer receives current replacement URL; existing service card supplies the same active resource.

No username/password or bearer-token flow was added. API keys are not entered in these commands. The prior authenticated HTTPS Mini App remains the only dynamic panel credential entry surface.

### Entitlement

`proposeMigration` takes the existing service lease, re-reads owner/identity, rejects pending/started unresolved renewal or repurchase, and captures source generation and origins. A successful source read by stable ID must match stored username and acceptable status. Finite quota minus verified used bytes, absolute expiry and device limit are extracted only when representable and supported. Fresh data has priority; a failed read can use the newest append-only saved observation for the **same service/panel/ID/username/origin**. A successfully read unsupported source is not replaced by an older convenient snapshot.

`confirmMigration` expires fresh previews after 60 seconds and re-reads fresh values. Changed/unavailable usage/expiry/hwid or unsupported settings stops acceptance rather than silently transferring the earlier larger quota. General drafts expire after five minutes. Manual data has unknown quota/usage explicitly recorded; provenance, entered/observed time and explicit confirmation method survive restart. There is no rounding a customer's bytes into gigabytes, resetting expiry to a new purchased duration, or silently fabricating usage.

`observationWriter` (`src/panels/registry.ts`) appends only verified API reads matching a known current purchase resource. Existing historical order amount/quota alone is not a trustworthy offline usage snapshot. Observations begin with this release; no observation is invented during schema upgrade.

### Permanent resource association

The logical service remains the same original purchase ID and customer. The immutable historical `orders` row is not recreated as a successful replacement purchase. `active_service_resources` links that logical service to the migration's verified destination panel/ID/username/URL/expiry/config. `effective_orders` explicitly exposes the original columns plus `active_migration_id`, substituting the active resource where present. Before cutover it is equivalent to original orders.

`src/db/orders.ts` readers use the view; renewal and repurchase booking writes active resource expiry/config/URL when migrated and retains historical source fields. `markPanelDeleted` is conditional on currently effective identity so a late source observation cannot delete the replacement. Customer ownership and uniqueness are protected in both engine reads and SQL guards.

Existing lifecycle routing was traced and integrated:

| Path | Files / functions | Routing after migration |
|---|---|---|
| New paid/trial/admin provisioning, pending new-order retry | `src/provision/provision.ts` / `provisionOrder`, existing assignment and claim logic | Existing persisted order assignment/default logic retained; migration does not alter global default. |
| Renewal, repurchase, reset and interrupted booking | `provisionOrder`, renewal/repurchase helpers; `src/db/orders.ts`; `src/panels/recovery.ts` / `recoverPanelOperations` | Effective original service re-read under lease, active destination config/identity; started operations block migration. |
| Customer status/usage/subscription card | `src/handlers/services.ts`; `getOrderById`; `resolveServicePanel` | Active generation, origin-pinned config and verified ID. |
| Admin/customer deletion | `src/handlers/panelDelete.ts`; `deletePanelService` | Effective service re-read under lease; migrated user mutations by stable ID. |
| Expiration/usage/test notifications | `src/db/serviceNotifications.ts`; `src/handlers/serviceNotifications.ts` / `runServiceNotificationSweep` | View reads and per-resource re-read/lease; no wrong-source deletion stamp. |
| Repurchase checkout and wallet path | `src/handlers/repurchase.ts`; migration-aware service lock and SQL checkout guard | Pre-cutover migration blocks new checkout before debit/order creation; existing wallet implementation retained. |
| Scheduled migration recovery/handoff | `src/index.ts`; `recoverServiceMigrations`; `deliverMigrationNotices` | Bounded independent steps; no global fallback or auto source deletion. |

## Durable state machine and recovery

| State | Required durable facts / bot-active resource | Recovery / destructive behavior |
|---|---|---|
| `review` | Source customer/resource/generation/origin, destination origin/policy, evidence and expiring operator confirmation; original active | No remote write. Safe draft cancellation/automatic expiry. Draft fences lifecycle mutation. |
| `creating` | Confirmed immutable entitlement, deterministic destination username and marker; attempts persisted **before POST**; original active | GET/reconcile first. Unknown POST outcome never blindly reissued by cron. Explicit retry may create only after supported absence, enabled destination and bounded attempts (max 3). Unique remote username and ownership marker prevent adoption of another resource. |
| `verified` | Strictly checked disabled candidate, external ID and HTTPS URL stored; original active | Separate request checkpoint. Next authorized continue or cron can activate; safe abort can remove only unpublished candidate. |
| `activating` | Intent persisted before active PUT; original still active until transaction | Read ID first; reconcile prior activation, verify latest URL including rotated URL, identity/quota/expiry/device/status; atomic conditional binding switch. No premature successful status. |
| `cleanup_pending` | Replacement active binding and latest URL durable | Customer notice/recovery; old source explicitly NOT confirmed revoked. No automatic source deletion. A later migration may proceed away from this current destination while old cleanup remains pending. |
| `completed` | Captured source ID absence verified with supported 404 and fresh active owner/ALL-user read evidence | Destination remains active; cleanup event/time recorded. No claim beyond supported API evidence. |
| `cancelled` | No create attempt, or unpublished candidate cleanup/absence sufficiently confirmed | Original active, migration history retained; another migration may be proposed. |

`abort_requested` is a separate irreversible flag for pre-cutover cleanup. If candidate outcome is uncertain/unreachable, the flag stays set and neither cron nor normal retry can activate it. Explicit retry reconciles before any subsequent destructive action. Source cleanup refuses to revoke the currently active `(panel, ID)`, including archived cleanup after later migrations.

Service lease acquisition checks the durable migration fence within SQL, not merely a prior read. Migration runners use a unique owner per execution. Partial unique index prevents concurrent pre-switch migrations. Checkout SQL trigger blocks new unresolved lifecycle orders while fenced. D1 batches make destination binding/status transitions transactional and condition them on the captured source generation. No schema field relies on isolate memory. App locks and mock races were tested; real distributed high-load behavior still needs staging validation.

## Migration-related defects addressed / safeguards added

These are narrowly scoped to migration safety; they are not a claim that all original bot identity risks were repaired.

1. **Legacy username mutation race.** An old username may refer to a replacement user. Migration source/candidate cleanup and migrated lifecycle mutations bind a verified stable external ID and use by-ID endpoints, even when the panel is the legacy environment panel. Tests rename/swap the source username and assert the unrelated replacement survives.
2. **Uncertified 404 deletion.** A proxy route or wrong endpoint response is not resource absence. Migrated resources require the supported JSON `User not found` contract, matching stored identity/origin, not generic status 404.
3. **Scoped 404 invisibility.** Official PasarGuard scopes user lookup to the principal. An OWN-scope 404 can hide a live user. `PasarGuardClient.canVerifyAbsence()` freshly verifies `/api/admin` active principal and owner/ALL read permission; migration source/candidate completion and migrated status/notification/delete enforce it. Six regressions cover restricted-scope cleanup, hidden active users and valid global absence. Insufficient scope yields typed permission/unconfirmed state, not deletion.
4. **Default/active switch race.** Operations re-read effective resource under lease; SQL fence prevents acquiring a normal lock during migration. Active origin is compared against recorded migration origin, including legacy environment configuration.
5. **Lifecycle checkout during migration.** Repurchase checks/fences occur before wallet debit; new lifecycle insert is protected at DB level. A pending started renewal blocks proposal. No payment logic rewrite.
6. **Interrupted booking and rotated URL.** Renewal/repurchase recovery books only current active generation; activation always verifies current remote URL after mutation, not the staging URL.
7. **Unknown abort could later activate.** Durable abort flag blocks recovery activation until explicit reconciled cleanup; no unsupported cancellation that merely drops a record.
8. **Upstream status incompatibility.** Verified public source rejects `on_hold` with absolute expiry and does not accept `disabled` on Create. Destination is created active with exact fixed entitlement, then disabled by verified ID before checkpoint. No unsupported payload is sent. Candidate can briefly exist active/unpublished; failure is durably recoverable, not falsely reported cutover.

### Public API source evidence, not live-panel evidence

Inspected PasarGuard public source at commit `b56ffe369f542152c52c69733205baeaf3f6e4cd` (source version markers 5.4.1):

- `app/routers/user.py`: by-ID PUT/DELETE/reset endpoints; existing client API-key conventions retained.
- `app/models/user.py` and `app/models/validators.py`: Create status contract, on-hold duration / absolute expiry incompatibility.
- `app/operation/user.py`: unique username conflict and permission/group handling; ordinary upstream user notifications may occur.
- `app/operation/__init__.py`: validated user lookup applies admin scope and returns 404 on invisible/missing users.
- `app/operation/permissions.py`: OWN filters by current admin; owner/ALL bypass ownership filter.
- `app/models/admin_role.py`: NONE=0, OWN=1, ALL=2 scope representation.

Source URL: https://github.com/PasarGuard/panel/tree/b56ffe369f542152c52c69733205baeaf3f6e4cd

Your actual panels' version, by-ID permissions, group persistence, subscription URL behavior and scoped errors must be checked in staging. No live connectivity or destructive panel test was performed.

## Database safety

`migrations/0022_service_migrations.sql` adds five tables, constraints/indexes/triggers and the effective view; does not rebuild or update existing tables. 0020/0021 are unchanged. No new legacy reassignment is made: original legacy/multi-panel/pending identities remain exactly as set by the existing baseline.

Panel-scoped external-ID uniqueness, cross-table conflicts, customer/resource consistency, irreversible abort, immutable confirmed entitlement/identity, historical-origin/delete protection, and verified activation are enforced in SQL. Original financial and usage/event relationships remain.

Executed permanent SQLite tests verify upgrade, transaction rollback, safe raw repeat failure and view-equivalence before cutover. Executed real Wrangler **local-only** D1 fixture upgrade from 0021, activation and repeat migration apply: 14 pre-existing tables byte-for-byte unchanged, zero FK violations, historical source retained while view resolves replacement. Wrangler reports no migrations on repeat. Raw CREATE scripts are intentionally versioned-once, not rerunnable standalone.

This is representative fixture evidence, **not proof that every production inconsistency is safe**. Back up and test a real sanitized/restored staging export before release. Apply 0022 before new Worker code. After first active migration, rolling back to a raw-orders 529 Worker is unsafe; use a view-aware forward fix/recovery. Do not drop migration/resource history as rollback.

## Security and previous authorization fixes

Preserved `src/panels/security.ts` exactly. Missing/empty/whitespace Telegram bot token still fails closed before HMAC validation. The Mini App generic GET shell still returns no existing metadata; POST metadata independently verifies fresh signed initData, current allowlist and session owner. Configure nonce remains one-use with concurrent duplicate-submission protection. Existing panel APIs still return no API keys.

`src/panels/admin.ts` changes only extend panel history checks; the authorization/session/origin logic is unchanged. Previous allowlist is `ADMIN_CHAT_ID` plus optional `PANEL_ADMIN_IDS`; positive canonical numeric user IDs only. Empty union denies. D1 customer `is_admin` is insufficient. Migration checks this independently rather than trusting `ctx.isAdmin`.

Existing AES-256-GCM credential storage with secret `PANEL_ENCRYPTION_KEY`, AAD, random IV and HTTPS/redirect/public-destination validation retained. No migration schema column stores panel keys or encryption key. Stored migration error fields are internal codes. Source/destination service URL necessarily exists as customer subscription data, not panel credential material; credential-bearing URLs are rejected. Customer URLs should remain access-controlled and not be dumped to logs.

## Actual executed validation

| Check | Result |
|---|---|
| `npm test` | **592 passed / 0 failed / 0 skipped**; original 529 + 63 additions |
| Focused migration/schema/auth/multi-panel/workflow suite | **134 passed / 0 failed / 0 skipped** |
| Migration regression file alone | **60 passed / 0 failed** |
| `npm run typecheck` | PASS, exit 0 |
| `wrangler deploy --dry-run --outdir ...` | PASS, exit 0; Wrangler 4.131.1, 801.16 KiB / gzip 154.80 KiB; **no deployment** |
| Wrangler isolated local D1 0021 -> 0022, activation, repeat | PASS; 14 tables unchanged, zero FK violations; repeat no-op |
| Baseline integrity | Security/auth tests, multi-panel tests, workflow-audit tests, 0020/0021, Wrangler config, package manifest/lockfile unchanged |
| Dedicated lint | No lint script/configured lint command in package.json; no dependencies added to invent one |
| Live panel/Telegram mobile/prod Cloudflare | NOT RUN / NOT VERIFIED |

The tests cover success, fresh preference/revalidation, saved identity/origin/timestamp, very stale confirmation, manual validation, source outage, unknown creation/deletion, destination failures, concurrency/duplicate callbacks, verified/interrupted activation, active URL rotation, financial preservation, checkout locks, cross-customer substitution, source rename/swap, default switches/third panel, repeated migration, archived cleanup, abort and restricted-scope absence. The suite is permanent in the delivered repository, not an external-only demo.

## Changed-file report (against 529 baseline)

**New:**
- `SUBSCRIPTION_MIGRATION_REPORT.md` — this report.
- `docs/en/subscription-migration-release.md` — operator workflow, limitations, exact Cloudflare inventory and release checklist.
- `migrations/0022_service_migrations.sql` — additive durable migration/resources/history/evidence schema.
- `src/migrations/service.ts` — authorized state machine, entitlement, idempotency, verification, activation, cleanup/recovery.
- `src/handlers/serviceMigration.ts` — private admin Telegram workflow, confirmations, safe status/errors, customer handoff.
- `tests/serviceMigration.test.ts` — 60 migration regressions.
- `tests/serviceMigrationSchema.test.ts` — 3 upgrade/rollback/preservation regressions.

**Modified:**
- `src/db/orders.ts` — effective reads, migrated booking and late-observation identity guard.
- `src/db/serviceNotifications.ts` — current-resource notification view reads.
- `src/handlers/callbacks.ts`, `src/handlers/commands.ts`, `src/lib/validate.ts` — new authorized command/callback routing and grammar.
- `src/handlers/panelDelete.ts` — re-read active service under lease before deletion.
- `src/handlers/repurchase.ts` — migration checkout fence before wallet mutation.
- `src/handlers/serviceNotifications.ts`, `src/handlers/services.ts` — current-generation lease/re-read and strict migrated resolver.
- `src/index.ts` — bounded migration recovery and handoff integration into existing cron.
- `src/panels/admin.ts` — extend existing panel URL/delete historical-reference guards only.
- `src/panels/recovery.ts` — current-resource repair/booking.
- `src/panels/registry.ts` — verified evidence snapshots, atomic migration lock fence, captured-origin migrated resolver.
- `src/pasarguard/client.ts` — migration opt-in strict stable-ID and global-absence policy, observations, product restriction parsing.
- `src/provision/provision.ts` — effective source identity/policy under lease, strict migrated routing.
- `tests/helpers.ts` — apply 0022 to test database fixtures.

Total: **23 changed files**; 7 new, 16 modified. Unrelated payment/wallet/customer/referral pricing functions, old migrations, deployment config and dependencies not rewritten. Prior 529 tests were not changed; helper/schema additions allow their execution on the additive schema.

## Remaining limitations and release prerequisites

1. **No atomic metered entitlement transfer.** Coordinate source quiescence for strict quota conservation. Old remote service can remain usable until revocation confirmed; never promise otherwise.
2. Supported automatic entitlement is fixed finite quota, absolute expiry and devices. Unlimited/periodic/next-plan/custom reset/proxy/autodelete settings require review and are not silently cloned. Destination groups are selected from its recorded provisioning policy; actual upstream group/policy persistence requires staging checks.
3. Unknown create outcome can leave unpublished candidate active/disabled; source remains locally current until verified cutover. Retry reconciles same deterministic resource; abort remains fenced until absence verified. Remote candidate may consume its quota before handoff; zero-used staging check stops automatic activation if that occurred.
4. Owner/ALL-user read visibility is required to certify deletion. OWN-only credentials can manage visible resources but cannot prove global absence; completion remains unconfirmed instead of guessing. Do not reduce permissions after staging without reviewing pending operations.
5. Non-migrated original legacy username/404 behavior remains unchanged; no blanket repair claim. Migration/migrated-resource operations opt into strict ID/origin/scope safety. If legacy environment origin was repointed before this release, historical provenance cannot be reconstructed automatically; operator review required.
6. DNS/public-address preflight and fetch resolution are not one atomic network firewall. Existing platform/network controls and DNS changes deserve staging security review.
7. Notices are at-least-once: crash after Telegram acceptance before local stamp can duplicate a message, not create a second service or charge. No guarantee of instantaneous cron/user delivery.
8. Append-only observations grow D1; retention and production plan/load/subrequest budget not load-tested. Recovery and handoff are bounded to two each per sweep, sharing budget with existing jobs.
9. No live-panel version/access, real mobile UX, production export, logs/secrets/account settings or distributed chaos test was performed. Local tests do not certify real-world security or production data.
10. Preserve the existing encryption master key, original legacy origin/key and webhook configuration. Verify production administrator IDs (checked-in ADMIN_CHAT_ID is empty), correct D1 binding and Mini App origin before approved release. No new migration secret/variable is required.

## Cloudflare handoff

The exact inventory and operator procedure are in `docs/en/subscription-migration-release.md`, derived from current code and unchanged Wrangler config. It identifies existing required/optional secrets/vars, their Worker dashboard destinations, DB binding, cron, origin/routes, 0022 ordering, rollback restrictions and post-deployment staging checks. No per-panel env variable, password/token secret, new migration origin or kill-switch is invented.

**Next action: review this release candidate and authorize a controlled staging rollout separately. Nothing in this handoff authorizes production deployment, secret changes or remote migrations.**
