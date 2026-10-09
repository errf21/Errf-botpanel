# Dynamic API-key multi-panel implementation report

## Outcome and scope

Updated the previously delivered multi-panel implementation locally against
original bot commit `348c2414dbae119b962076fed9223d3edc29970b`.
**Implemented code, not an audit-only proposal. No production activation claimed.**
No commits, pushes, remote migrations, deployments, production secret/configuration
changes, production credentials or live panel calls were made.

## Corrected behavior

- Up to 100 panels total, including legacy, with stable opaque IDs; no two-panel
  index, per-panel environment variable or redeploy requirement for future additions.
- Every panel uses the existing `X-Api-Key` request convention. The legacy
  `PASARGUARD_PANEL_URL` / `PASARGUARD_API_KEY` remain unchanged and authoritative.
- Removed username/password login, bearer-token provider/cache/refresh and login
  safety gates. `src/panels/tokens.ts` was removed; its bounded response-reader
  utility lives in `src/panels/http.ts`. Historical migration 0020 stays immutable.
- Private Cloudflare-authorized `/panels` supports paginated listing, add, read-only
  connection/permission/group testing, edit, confirmed enable/disable, confirmed
  default selection, and guarded deletion. Keys are never revealed/prefilled.
- Add/edit uses the existing secure Telegram Mini App: signed/fresh initData,
  actor-bound one-use nonce, five-minute expiry, HTTPS same-origin POST, CSP,
  no-store responses, strict validation and encrypted API-key persistence.
- Configuration is tested BEFORE acceptance. Failed key/permission/group tests
  leave the previous panel configuration untouched. Blank edit-key retains it.
- D1 selection uses revision-based conditional writes and audit, not memory.
- Creation claims persist panel ID/policy before remote provisioning. New selection
  affects unassigned new claims; retries, renewals, repurchases, resets, status,
  deletion, URLs, paid/trial usage and expiration notices retain original routing.
- No automatic cross-panel fallback; uncertain create is reconciled, not blindly
  duplicated; reset uncertainty still requires operator review.
- Duplicate origins (including the legacy environment origin) are rejected.
  Origin changes are blocked once ANY order references a panel. Deletion requires
  no order associations at all and a non-selected/non-legacy panel. Disable is the
  safe archival option; no unsafe automatic reassignment feature was introduced.

## Principal implementation modules

- `src/panels/registry.ts`: dynamic IDs, encrypted API-key resolution, group policy,
  stable-ID clients and existing per-service operation leases.
- `src/panels/admin.ts`: dynamic pagination/actions, secure credential form,
  before-save validation, selection/configuration CAS, deletion safety and audit.
- `src/panels/security.ts`: authorization, URL validation, AES-GCM/AAD, initData
  verification and public DNS destination checks before dynamic API requests.
- `src/panels/http.ts`: bounded streamed response reader, no authentication logic.
- `src/pasarguard/client.ts`: API-key-only headers, timeouts/no redirects, typed
  redacted errors, strict dynamic absence and stable-ID/rename safeguards.
- `src/provision/provision.ts` and `src/db/orders.ts`: claim/policy pinning,
  lifecycle routing, deterministic create reconciliation and fixed retry targets.
- Service/notification/delete handlers and `src/panels/recovery.ts`: original-panel
  operations and bounded crash recovery; these useful previous changes are retained.

All actual PasarGuard writes are behind the shared `provisionOrder`/client funnel.
Inspected entry points include admin payment approval, wallet-paid purchases,
free-trial fulfillment, failed-order retry and scheduled approved-order recovery.
No unrelated business workflow was intentionally removed or redesigned.

## Migration and data preservation

- `0020_multi_panel.sql`: unchanged from the prior delivery; associates pre-existing
  records with legacy, retains the old UNIQUE ID column, introduces scoped raw IDs,
  immutable assignments, policy/expiry/claim state, selection/audit/sessions/leases.
- NEW `0021_dynamic_api_key_panels.sql`: replaces ONLY the panel registry, removes
  its two-ID CHECK and obsolete password/token columns, preserves all IDs/references
  and adds origin/deletion guards. Child NO ACTION FKs are deferred during replacement;
  explicit `pragma_foreign_key_check` integrity guard must pass before committing.
- Existing 0020 password secondary records retain their ID and assigned services,
  but obsolete credentials are removed and new creation is disabled. If selected,
  default returns to legacy. Re-enter the API key through Edit on that same panel ID
  during maintenance. Never recreate/reassign those services to a new ID.
- Orders/customer/payment/wallet/referral/notification tables are not rebuilt by
  0021. All existing relationships remain; `(panel_id,pasarguard_user_id)` stays UNIQUE.
- Files are versioned one-time migrations; repeatability comes from Wrangler's
  migration history, not rerunning raw SQL. Do not edit historical applied files.

## Bindings and manual setup

Keep all existing secrets/bindings. The only multi-panel setup is:
- Secret `PANEL_ENCRYPTION_KEY`: base64 of exactly 32 random bytes.
- Variable `PANEL_ADMIN_ORIGIN`: this Worker's public HTTPS origin.
- Optional `PANEL_ADMIN_IDS`: extra numeric Telegram admin IDs.

No per-panel configuration bindings. Removed/unused: `PANEL_ALLOWED_ORIGINS`,
`PANEL_PASSWORD_LOGIN_SAFE`; no username/password or bearer setup is needed.
The previous upstream failed-login-password prerequisite no longer applies because
this bot does not perform password authentication.

See `docs/en/multi-panel.md` for precise secure secret setup, backup, provisioning
pause/drain, staged local/remote migration and deployment, Telegram workflow and
panel-aware rollback. Production steps are documented, NOT executed. Reconcile the
checked-in empty ADMIN_CHAT_ID, literal legacy URL and D1 ID before an approved
rollout. Never overwrite the working legacy API key.

## Security and limitations

- Dynamic keys are AES-256-GCM ciphertext in D1, with unique nonce and AAD binding
  panel ID, revision, origin and purpose; master secret is separate in Cloudflare.
- Dynamic destinations require public HTTPS DNS names; IPs, local names, credentials,
  queries/paths, alternate ports and redirects are rejected. Public A/AAAA preflight
  runs before each key-bearing fetch. DNS and fetch resolve separately: not an
  atomic DNS-pinned egress firewall. Trust authorized admins and panel DNS/TLS owners;
  stronger hostile-DNS egress enforcement would require a separate proxy policy.
- API test verifies the inspected declared permission/group contract, not live
  user writes, quota adequacy or all deployments. Unsupported contracts fail closed.
- Last test status/time is a snapshot, not continuous health monitoring.
- Master-key rotation requires an approved re-encryption operation, not simple secret
  replacement. Per-panel API-key replacement is implemented and tested.
- Deletion is deliberately conservative: history also blocks it. URL repointing on
  associated panels and automatic service reassignment are intentionally not provided.
- Size Worker/D1 capacity for actual service traffic and extra DNS subrequests;
  100 registry entries is not a throughput guarantee. See setup guide for limits.

## Checks actually executed

- Baseline original suite: 458 passing tests (previously recorded).
- Final full suite: **501/501 passed**, zero failed/skipped; 43 multi-panel/API-key tests.
- `npm run typecheck`: passed.
- Wrangler `deploy --dry-run`: passed; 745.78 KiB / gzip 143.34 KiB; NOT deployed.
- Existing local D1 migration application of 0021: passed.
- Separate seeded local D1 0020 -> 0021 upgrade: passed, preserving secondary service
  identity, receipts/references, balances, wallet ledger, events and notifications.
- Repeat local migration application: no pending migrations.
- Local D1 foreign-key/schema checks: passed; token/login columns absent.
- In-memory FK-enabled financial/relationship retention tests: passed byte-for-byte.
- Inconsistent historical-FK migration guard rollback test: passed.
- `git diff --check`: passed.
- No lint script/configuration exists; no independent lint pass is claimed.

Tests cover three dynamically added panels plus legacy, switching across all four,
real Telegram approval/duplicate delivery/free trial, cron recovery, original-panel
lifecycle routing while disabled, retries/ambiguous writes, scoped IDs, permission/key
failures, secure entry/replay/tampering, masking/redaction, origin/DNS/redirect guards,
concurrent/stale selection and deletion, limits/pagination, and both schema transitions.
Existing payment/wallet/referral/pricing/business tests continue to pass.

Dependencies/package manifests and Wrangler configuration are unchanged. The prior
npm audit reported four HIGH findings in the locked development toolchain
(wrangler/miniflare/sharp/undici); no dependency upgrade/security fix is claimed here.

## Delivery patch targets

- `errf-api-key-update.patch`: incremental change against the previously delivered
  two-panel implementation (removes tokens.ts, preserves 0020).
- `errf-dynamic-api-key.patch`: complete changes against original GitHub commit above.
- Complete repository ZIP includes source/docs/tests/migrations, not .git,
  node_modules, local D1 databases, builds or private credentials.

Both patches must be checked against the matching baseline. Never apply either
blindly over unrelated changes. ZIP is the complete updated source alternative.

## Verified / not verified

Verified: source call paths, pinned official API-key authentication implementation,
mocked functional/security behavior, TypeScript/build and local migration integrity.
NOT verified: live panel version/connectivity/permissions/quota, real credentials,
production migration state or deployed end-to-end behavior. No live test results
were invented. Production rollout and any further changes await explicit approval.

## Changed/new files relative to original GitHub baseline

- `.dev.vars.example`
- `IMPLEMENTATION_REPORT.md`
- `README.md`
- `docs/en/multi-panel.md`
- `docs/fa/multi-panel.md`
- `migrations/0020_multi_panel.sql`
- `migrations/0021_dynamic_api_key_panels.sql`
- `src/db/orders.ts`
- `src/db/serviceNotifications.ts`
- `src/dispatch.ts`
- `src/handlers/callbacks.ts`
- `src/handlers/commands.ts`
- `src/handlers/panelDelete.ts`
- `src/handlers/serviceNotifications.ts`
- `src/handlers/services.ts`
- `src/index.ts`
- `src/lib/validate.ts`
- `src/panels/admin.ts`
- `src/panels/http.ts`
- `src/panels/recovery.ts`
- `src/panels/registry.ts`
- `src/panels/security.ts`
- `src/pasarguard/client.ts`
- `src/provision/provision.ts`
- `src/types.ts`
- `tests/configname.test.ts`
- `tests/helpers.ts`
- `tests/multiPanel.test.ts`
- `tests/panelDelete.test.ts`
- `tests/phase5.test.ts`
