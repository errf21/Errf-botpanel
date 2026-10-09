# Multi-panel workflow audit and targeted fixes

## Verdict and scope

**Suitable to prepare a controlled staging rollout, subject to the compatibility and operational gates below. Not a production-safety certification.**

Baseline: the exact local implementation containing the previous authorization fixes and 516 passing tests, not a fresh checkout of GitHub. Those files were snapshotted before this work. Git HEAD remains `348c2414dbae119b962076fed9223d3edc29970b`; prior feature work and this delivery remain uncommitted.

The audit traced actual callers, SQL guards, API requests, notification legs and recovery writes. Seven failing regression cases reproduced five defect categories on the unchanged baseline; targeted fixes and additional regressions now pass. No subscription-migration feature was started. No production panel, credentials, Cloudflare resources or production database were accessed. No deployment, commit or push occurred.

## 1. Requirements matrix

“PASS” below means source inspection plus the stated isolated local evidence, not live-service or production-data verification.

| # | Requirement | Result | Evidence / qualification |
|---|---|---|---|
| 1 | Multiple dynamically administered API-key panels, no password/token login | PASS | `registry.ts:resolvePanel`, `MAX_PANELS=100`; `admin.ts:panelCallback/panelAdminRoute`; mocks add three dynamic panels and switch across four destinations including legacy. No runtime password/bearer acquisition. |
| 2 | Server-side authorization for creation, editing, testing, enable/disable, selection, deletion | PASS | `security.ts:isPanelAdmin/verifyInitData`; `admin.ts:privateAdmin`, every callback gate, metadata/configure route. Unauthorized callbacks and direct endpoints rejected. |
| 3 | API-key confidentiality and encryption | PASS locally; production NOT VERIFIED | AES-256-GCM, independent random 12-byte IV per encryption, panel/revision/origin AAD; base64 32-byte Worker secret; explicit metadata DTO excludes key/ciphertext. Synthetic key redaction and ciphertext-transplant tests pass. Production secrets/backups/log pipelines not inspected. |
| 4 | New provisioning follows persistent selected default | PASS | `provisionOrder` → `claimOrderForProvisioning`; D1 selection/revision/enabled checks in claim transaction. Paid approval, trial, cron recovery and concurrent switch tests. Draft orders need not be assigned until provisioning claims them. |
| 5 | Ownership is durable before first remote provisioning request | PASS | Claim writes immutable `panel_id`, configuration snapshot and claim UUID before client use; deterministic username/expiry saved before create. New mock asserts D1 ownership before every remote user request. |
| 6 | Lifecycle operations use original panel | PASS for panel routing; legacy identity caveat below | Renewal, repurchase/reset, status, deletion, notices, subscription URLs and recovery use stored ownership. Three distinct mock origins, keys and external IDs tested. Dynamic stable-ID mutation race fixed; retained legacy username conventions have a residual out-of-band identity race. |
| 7 | No silent cross-panel fallback | PASS | Failed API-key authentication, uncertain creation, malformed/proxy 404 and retry tests; registry/client return errors without consulting another panel. |
| 8 | Customer/financial/history preservation | PASS for local fixtures; production NOT VERIFIED | Full suite includes payment/wallet/referral tests. SQLite and actual local Wrangler D1 upgrade snapshots preserve original fields and relationships. No production inventory/export was available. |
| 9 | Legacy configuration and original association preserved | PASS conditionally | `resolvePanel('legacy')` retains original environment URL/key; 0020 stamps pre-existing orders legacy. Correctness assumes those records actually originated on that unchanged panel. This cannot be inferred from IDs alone. |
| 10 | Safe versioned migrations and applicable repeat safety | PASS locally; production NOT VERIFIED | 0020/0021 unchanged. Versioned Wrangler repeat reports “No migrations to apply”; FK guard/rollback tests pass. Raw migration scripts are intentionally not rerunnable. |
| 11 | Deletion/URL edits cannot invalidate historical ownership | PASS | Application SQL and 0021 triggers reject origin changes with ANY associated order and deletion of associated/selected/legacy panels. Concurrency test assigns an order after confirmation and blocks deletion. No automatic reassignment. |
| 12 | Previous authorization fixes remain intact | PASS | Four original security/entrypoint/test files byte-for-byte unchanged; all 15 authorization regressions pass, including authenticated metadata, missing-token fail-closed, actor ownership and duplicate nonce consumption. |

## 2. Exact lifecycle trace

All paths enter through authenticated Telegram webhook → `dispatch.ts` → existing command/callback handlers. `routes/webhook.ts:handleWebhook` requires the configured webhook secret; ordinary clients cannot simply supply a Telegram administrator ID to that endpoint.

| Path | Actual source/function | Panel resolution |
|---|---|---|
| Paid receipt/admin approval | `src/admin.ts:performAdminReview` (provision call near line 307) | Shared `provisionOrder`: stored assignment or current default at first claim. |
| Wallet-funded purchase | `src/handlers/purchase.ts:confirmPurchaseWithWallet/afterOrderApproved` (449) | Same provisioning funnel; financial workflows unchanged. |
| Free trial | `src/handlers/freeTest.ts:claimFreeTestTap/afterTestOrderApproved` (80) | Same new-purchase claim; selected arbitrary panel and its groups. |
| Administrator service creation/approval | Existing order-review path above | No independent new remote-create bypass was found. There is no separate new arbitrary-user creation endpoint to route. |
| Failed/pending retry | `src/handlers/provisioning.ts:handleProvisionRetry`; `src/panels/recovery.ts:recoverPanelOperations` | Assigned order retained; stale uncertain writes become failed for explicit retry, never silently recreated elsewhere. |
| Renewal | `src/provision/provision.ts:provisionRenewal` (534), `finalizeRenewalSuccess` | Original service `panel_id` and expected external ID; absolute target retained for retries. |
| Repurchase / quota and traffic reset | `provisionRepurchase` (803), `finalizeRepurchaseSuccess`; `repurchase.ts:confirmRepurchase` | Original service; durable absolute quota/expiry/device targets and reset-claim flag. Unknown reset outcome is not blindly reissued. |
| Status and usage | `src/handlers/services.ts:renderServiceDetail` (190; client near 223) | `resolvePanel(service.panel_id)` and stored user ID. |
| Admin deletion | `src/handlers/panelDelete.ts:handlePanelDeleteCallback` → `deletePanelService` (provision module 125) | Service lease, original panel, read-before/read-after confirmation; local historical record retained. |
| Subscription URL | `finalizeSuccess/finalizeCreate/finalizeRepurchaseSuccess`, service detail/cards | Returned URL resolved against assigned panel origin; repurchase's rotated URL now durably stored and recovered. |
| Notifications | `src/handlers/serviceNotifications.ts:runServiceNotificationSweep` (204; remote legs 307,380,449) | Paid and trial usage reads use each row's panel/ID. Pure expiration notices use stored expiry/URL and do not contact the selected default. |
| Scheduled reconciliation | `src/index.ts:scheduled` → recovery and independent notification sweeps | Stored order/service ownership; no fallback; local booking repair now shares service leases. |

Direct legacy bindings remain only in the legacy configuration loader, duplicate-origin validation, type declarations and health configured/not-configured booleans. No dynamic-service lifecycle call was found using the global credentials in place of its assigned panel.

Default switching versus claim is serialized by D1 transaction predicates: unassigned new claims require the observed selection revision, panel revision and enabled state. A stale claimant loses rather than writing to the stale destination. Assigned retries bypass default selection but still require their own panel configuration. Changes after a successful claim cannot alter ownership. Configuration/group snapshots are preserved across retries. Disabling blocks unassigned new provisioning; existing assignments, including pending retries, retain management access.

## 3. Reproduced defects and exact corrections

All five categories below were reproduced with synthetic responses/local D1, not inferred live failures.

### D1 — High: create-expiry repair could adopt the wrong response identity

`src/provision/provision.ts:finalizeCreate/ensureCreateExpiry` accepted a corrective PUT envelope containing user ID 999 and an unrelated subscription URL after initial verified creation of ID 201. The completed order could become associated with that unrelated response.

Fix: bind the verified initial ID with `PasarGuardClient.withExpectedUserId` before expiry repair. Mismatched mutation envelopes fail identity validation; reconciliation can accept only the original resource read-back. Regression returns a deliberately wrong envelope while applying the expiry to the true resource; final stored ID stays 201 and unrelated URL is rejected.

### D2 — High: dynamic username mutation race could affect a replacement resource

`src/pasarguard/client.ts:modifyUserByUsername/resetUserUsageByUsername/deleteUserByUsername` originally mutated by username after prechecking ID. Replacing that username's user between precheck and write caused modification, usage reset or deletion of ID 999 rather than stored ID 201. A response identity check came too late to prevent the write.

Fix: dynamic mutations with a known stored ID use supported `/api/user/by-id/{id}` endpoints, with strict numeric ID validation and no fallback to username after failure. The verified initial creation ID is also bound for corrective PUT. Existing method names/callers remain; API-key headers, payloads, timeout and no-retry policy unchanged. Legacy username endpoints remain intentionally unchanged; see remaining risk below.

Official upstream at commit `b56ffe369f542152c52c69733205baeaf3f6e4cd` (version markers 5.4.1), `app/routers/user.py`, defines PUT by-ID at lines 137–148, DELETE at 218–228 and POST reset at 254–262. They require `users.update`, `users.delete` and `users.reset_usage` respectively, like username equivalents. This source check does NOT prove deployment/version compatibility. [^https://github.com/PasarGuard/panel/blob/b56ffe369f542152c52c69733205baeaf3f6e4cd/app/routers/user.py]

### D3 — Medium: recovery queue head-of-line starvation

`src/panels/recovery.ts:recoverPanelOperations` repeatedly selected only the oldest two approved orders. Two orders owned by an unconfigured panel could block healthy-panel recovery forever.

Fix: scan at most 20 candidates, cap at two claimed provisioning attempts, and compare-and-swap the scheduling timestamp of unchanged/unclaimable approved rows to rotate them. Ownership, targets, payment state and attempt counts are not moved/reset. Tests cover two and 21 blocked orders plus three healthy orders over successive sweeps.

### D4 — High: interrupted repurchase booking lost current URL and notice lifecycle

`src/db/orders.ts:completeRepurchasedOrder` stored the rotated URL only in its event; recovery read the empty column. Interrupted booking left the old subscription URL and already-sent paid notices. The prior separate notice-rearm call also left a crash gap.

Fix: persist the current URL on the completed repurchase order. `bookRepurchaseOnService` atomically updates forward-only expiry/URL, deletes only paid `usage90`/`expiring` markers and records a guarded one-time booking event in a D1 batch. Remove the separate best-effort rearm from `finalizeRepurchaseSuccess`. Recovery accepts historical event-only URLs and repairs even when expiry already matches. A second repair cannot clear notices emitted for the new cycle. Trigger-injected failure proves batch rollback and later successful repair. Service identity, original panel, financial accounting and historic orders are unchanged.

### D5 — Medium: recovery booking ignored service mutation leases

`recoverPanelOperations` repaired service expiry while a different service operation held its lease.

Fix: acquire the same service lease as provisioning/deletion, re-evaluate ownership/deletion/newer-operation predicates after acquisition, and release in `finally`. Recovery does not book a stale operation over a newer completion. Regression proves a held lease prevents booking, releasing permits repair, and a failed batch releases the lease.

## 4. Security and prior authorization fixes

Unchanged implementations:
- `src/panels/admin.ts`: SHA-256 `89bb706237b64479670c547f19b2c4409baba1554e3d77a99d4a8bfbe8ec9600`
- `src/panels/security.ts`: `5f0693c6dee1eff02c61fdb72757af5cf6a7b9197f624faf2bd7a896c5307a06`
- `src/index.ts`: `9efde5d884be2369675af7f3de12b8c213528086e0e179888c2949376611aa1f`
- `tests/panelAuthorization.test.ts`: `74920fc02f9001d502d2c39eec648e9203b9bfdfcacc9a20d59a1b7c53018ad1`

The allowlist is the union of numeric positive `ADMIN_CHAT_ID` and comma-separated `PANEL_ADMIN_IDS`. Both absent/empty means denial; D1-only administrator flags do not grant panel management. Private chat is also required for bot management handlers.

Mini App metadata and configuration independently validate HMAC-signed Telegram initData using the required configured bot token, maximum age five minutes and maximum future skew 30 seconds, rejecting duplicate fields. Missing/empty/whitespace-only bot tokens reject before signature derivation. Actor ID comes only from that validated payload and current allowlist. Session nonce must match actor/action/expiry/revision. Public GET returns a generic shell only. Metadata intentionally allows repeated authenticated reads within the session; mutation atomically consumes the nonce once. Concurrent duplicate submission has one winner. `PANEL_ADMIN_ORIGIN`, request origin/content-type and URL nonce are additional constraints, never identity proof. No key-retrieval endpoint exists.

AES-GCM master key remains a Worker secret; ciphertext, random IV and version only are stored in D1. Existing stored keys are never prefilled into the browser; only freshly entered keys are transmitted over HTTPS. Raw upstream bodies and exception strings are not included in diagnostics. URLs reject paths, credentials, queries, non-443 ports, literal IPs and local names; public A/AAAA preflight runs before dynamic key requests and fetch never follows redirects.

## 5. Schema and local migration evidence

No migration was created or modified this phase. No new columns or secrets are required by these fixes.

0020 creates legacy registry/selection; renames the old globally unique external-ID column to preserve it, adds authoritative `(panel_id,pasarguard_user_id)` identity, assigns EVERY pre-existing order (including pending) to legacy and installs immutable ownership. Bot writes do not replace the historical unique ID column. Cross-panel equal raw IDs are supported by the composite index.

0021 rebuilds ONLY the panel registry under deferred non-cascading references, retains IDs/child tables and adds origin/deletion guards. Obsolete password credentials/tokens are intentionally discarded; those rows retain IDs, become disabled and need API keys entered on that same ID. Selection is reset to legacy if it selected a password panel. A FK guard aborts inconsistent data. This is not reversible password-secret recovery; backup before any approved rollout.

Executed this phase:
1. Existing automated SQLite seeded preservation/constraint/rollback tests.
2. Fresh Wrangler local D1 fixture: apply 0001–0019, seed two customers and two completed/pending orders, wallet debit/top-up, referral, trial association, event, notice and 13 settings; snapshot all original fields; apply 0020/0021; compare original fields, raw/historical ID, relationships and pending attempt/state.
3. All seeded records/fields preserved, both orders assigned legacy, zero `foreign_key_check` violations.
4. Repeat Wrangler migration invocation: “No migrations to apply.” Existing earlier local fixture repeat also reported no pending migrations.

An initial inspection selected Miniflare's metadata SQLite file instead of the D1 database; that inspection failed and was corrected before preservation comparisons. Actual upgrade and verification then succeeded. These fixtures do not represent an inspected production export. Raw SQL repeat application is not supported; Wrangler migration history is the repeat guard. No automatic reverse migration is supplied; restore a verified database/secret backup or roll forward if a schema rollback is needed.

## 6. Tests and actual execution results

| Check | Executed command / scope | Result |
|---|---|---|
| Full suite | `npm test` | **529 passed, 0 failed**, 0 skipped/cancelled |
| Targeted panel/security/workflow suite | `node --disable-warning=ExperimentalWarning --test tests/multiPanelWorkflowAudit.test.ts tests/multiPanel.test.ts tests/panelAuthorization.test.ts` | **71 passed, 0 failed** |
| Prior authorization regression suite | `node --disable-warning=ExperimentalWarning --test tests/panelAuthorization.test.ts` | **15 passed, 0 failed**; also included in final full suite |
| TypeScript | `npm run typecheck` | PASS, no diagnostics |
| Worker build | `node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir <external-local-output>` | PASS, Wrangler 4.131.1; 750.65 KiB / gzip 144.50 KiB; dry-run exits, no deployment |
| Local migration upgrade/repeat | Wrangler `d1 migrations apply … --local` with isolated config/state | PASS as described above |
| Lint | No lint script/configured lint suite in package scripts | NOT RUN; not represented as a passing check |
| Live PasarGuard / mobile Telegram / production Cloudflare | Not authorized or accessed | NOT VERIFIED |

Thirteen new tests in `tests/multiPanelWorkflowAudit.test.ts`: corrective-identity envelope, blocked recovery queue, interrupted repurchase URL/notices, lease exclusion, PUT/reset/DELETE replacement races (three), three-panel lifecycle/status/repurchase routing, >20-row fair recovery/write cap, historical event-only recovery/replay, superseded operation protection, all-three renewal/notices/deletion while disabled/non-default, transactional booking rollback/released lease. Fixtures use distinct panel origins, keys and external IDs 101/201/301. Existing suite additionally tests paid/admin/trial paths, same-ID collisions across panels, default-switch concurrency, uncertain retries, ownership before writes, no fallback, group snapshots, deletion/origin guards and sensitive-output redaction.

## 7. Exact changed-file list relative to the 516-test baseline

1. `src/pasarguard/client.ts` — bind verified identities; dynamic stable-ID mutation paths.
2. `src/provision/provision.ts` — bind create identity; remove separate non-atomic notice rearm.
3. `src/db/orders.ts` — persist repurchase URL; atomic, idempotent service booking/rearm.
4. `src/panels/recovery.ts` — leased/revalidated repair; historical URL recovery; bounded fair scheduling.
5. `tests/multiPanel.test.ts` — mock stable-ID reset/delete routing, without weakening assertions.
6. `tests/multiPanelWorkflowAudit.test.ts` — new, 13 permanent tests.
7. `WORKFLOW_AUDIT_REPORT.md` — this handoff.

Authorization files, 0020/0021, Wrangler configuration, dependency manifests/lockfile, payment/wallet/referral/customer/pricing handlers and all other baseline files are unchanged. Previous reports remain historical; this report supersedes their current test counts. Patch applies to the exact 516-test local baseline, NOT vanilla GitHub HEAD. Complete ZIP includes the accumulated multi-panel implementation and earlier authorization fixes, excludes dependencies, Git metadata, real local secrets and local databases/builds.

## 8. Remaining limitations and staging gates

- **High, code-inferred retained legacy identity risk:** legacy mutations retain username routes and legacy 404 classification for compatibility. Out-of-band rename/delete/replacement between precheck and mutation can still target the replacement username; a proxy/route 404 on legacy is less strictly certified than dynamic absence. New stable-ID race regressions cover dynamic panels, NOT elimination of this legacy behavior. Do not infer total resource-identity safety on legacy from them. Prevent external rename/replacement during staging, verify actual legacy 404 semantics; assess a separately authorized legacy stable-ID/strict-absence hardening change after verifying its deployed contract. This is a staging limitation, not silently declared fixed.
- **NOT VERIFIED:** deployed panel versions and by-ID support. Dynamic mutation routes were verified in pinned official source and mocks only. Stage read/create/update/reset/delete with synthetic users on every intended deployed panel; incompatible endpoints fail without falling back. Read-only management tests verify declared permissions/groups, not actual writes, account quotas or future health.
- **Legacy provenance assumption:** never repoint `PASARGUARD_PANEL_URL` or replace its key as a panel switch. Inventory existing production services/IDs against the true original origin before approving 0020. The code cannot infer that provenance retrospectively.
- **DNS/SSRF boundary:** preflight lookup and Worker fetch are separate resolutions, not atomic IP-pinned egress. Trust administrator-selected DNS/TLS owners; for stronger assurance use separately reviewed host/egress restrictions. Browser/Telegram compromise and malicious administrators remain out of scope.
- **Secrets and recovery:** confirm `PANEL_ENCRYPTION_KEY` persists across releases and backups; loss makes dynamic credentials unusable. Do not rotate it without authenticated re-encryption. No automatic key-rotation workflow added.
- **Deployment reconciliation:** checked-in `ADMIN_CHAT_ID` is empty and legacy URL/D1 ID are concrete. Before approved staging, reconcile actual bindings; do not overwrite working production values. `PANEL_ADMIN_ORIGIN` must be the actual HTTPS Worker origin; optional `PANEL_ADMIN_IDS` contains only explicit trusted numeric IDs. No new per-panel bindings, login secrets or deployment setup are required by these fixes. Existing `docs/en/multi-panel.md` setup remains applicable; this report updates its dynamic mutation contract.
- **Scale:** registry cap is 100, not a throughput promise. Recovery repairs five candidate bookings, scans twenty approved rows and permits two provisioning claims per sweep. Existing cron/notification limits and D1/Worker/API plan limits still apply. No production load/latency test performed.
- Expiry notifications rely on cached expiry, not live synchronization of external admin edits. Forward-only service-expiry booking policy is preserved. Failed uncertain resets require verification rather than automatic replay. No automatic service migration/reassignment, new standalone admin-creation workflow or continuous connection monitoring was introduced.

Before any production approval: stage on isolated bindings/database, verify actual panel versions/endpoints and Telegram mobile UX, take tested database/master-secret backups, check legacy provenance and the retained legacy limitations, then repeat lifecycle/concurrency/crash tests under realistic limits. No production action is authorized by this delivery.
