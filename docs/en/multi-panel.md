# Dynamic API-key PasarGuard panels — setup and safe rollout

## Scope

This implementation extends the existing bot; it does not replace its payment,
wallet, referral, pricing, renewal, trial or notification workflows. The original
panel remains `legacy` and continues reading `PASARGUARD_PANEL_URL` and
`PASARGUARD_API_KEY`. **Do not replace that key or repoint its URL to another panel.**

All dynamic panels use the same working `X-Api-Key` convention. There is NO
username/password login, bearer-token acquisition/cache or password-safety gate.
A password-shaped HTML input masks the API key; it is not password authentication.

There is a conservative **100-panel total limit**, including legacy, and five
panels per Telegram list page. No panel number/index is hardcoded into routing.
Adding subsequent panels requires neither code edits, per-panel bindings nor
redeployment. This is not an unlimited scale guarantee: total service traffic,
D1 queries/storage, cron batches, API rate limits and Worker limits still apply.

## Verified API contract and compatibility

Inspected official source: PasarGuard commit
`b56ffe369f542152c52c69733205baeaf3f6e4cd` (source version markers 5.4.1).
`app/routers/authentication.py:_extract_api_key` accepts `X-Api-Key`, and
`get_admin_from_api_key` resolves the authenticated principal. The current-admin
route is `GET /api/admin`, through `get_current_with_metrics`. This bot follows
its pre-existing user routes (`/api/user`, `/api/user/by-username/...`, reset and
by-id read-back) without changing the legacy key/header.

Dynamic configuration is accepted only after read-only checks of:
- API-key authentication and active admin principal via `GET /api/admin`.
- Owner status, or declared `users.create/read/update/reset_usage/delete` access.
- Every configured group via `GET /api/group/{id}`.

Owned/all user scopes are accepted; the key's principal must remain able to manage
users it created. The test checks **declared** permissions, not live mutations,
quota sufficiency, future availability or every PasarGuard deployment variant.
A variant that cannot return this permission/group contract is rejected rather
than guessed compatible. No live panel has been tested by this implementation task.

## One-time Cloudflare bindings

Keep all existing bindings (D1 DB, Telegram secrets, admin ID, seller-card secret,
legacy panel URL/API key, business settings and cron).

| Binding | Type | Purpose |
| --- | --- | --- |
| `PANEL_ENCRYPTION_KEY` | Worker secret | Base64 encoding of exactly 32 random bytes, AES-256-GCM master key |
| `PANEL_ADMIN_ORIGIN` | Non-secret variable | Public HTTPS origin serving this Worker, e.g. `https://bot.example.com` |
| `PANEL_ADMIN_IDS` | Optional non-secret variable | Comma-separated additional numeric Telegram administrator IDs |

`ADMIN_CHAT_ID` must be the existing authorized administrator's numeric user ID,
not a group/channel ID. Every management command, callback and configuration POST
checks numeric IDs against these Cloudflare bindings. A D1 `is_admin` flag alone
is NOT sufficient. Management buttons/forms are offered only in private chat.

No per-panel origin allowlist binding is required. Administrators register public
HTTPS panel origins dynamically. `PANEL_ALLOWED_ORIGINS` and
`PANEL_PASSWORD_LOGIN_SAFE` are obsolete and unused; remove them from deployment
configuration during an approved rollout if previously configured. There are no
panel username/password variables or bearer-token secrets to configure.

### Configure the master secret, only when deployment is approved

Generate/store the master key on an operator-controlled machine, outside Git:

```sh
umask 077
openssl rand -base64 32 > /secure/location/panel-master-key.txt
npx wrangler secret put PANEL_ENCRYPTION_KEY < /secure/location/panel-master-key.txt
```

Replace `/secure/location` with a private location. Do NOT put the actual secret
in source, command arguments, screenshots, Telegram chat or this report.
Back it up in your password/secret manager. Do not generate a new key for each
panel or overwrite a key that already encrypts existing panel credentials.

`wrangler secret put` can create/activate a Worker version. If preparing a staged
version, use the Cloudflare versions workflow (`wrangler versions secret put
PANEL_ENCRYPTION_KEY`) and separately approve its activation; do not assume a
secret write is a harmless dashboard-only operation. Use staging first.

Set `PANEL_ADMIN_ORIGIN` and optional `PANEL_ADMIN_IDS` once in the Worker's
non-secret configuration. For CLI deployment, merge them into the existing
`wrangler.jsonc` `vars` object; preserve existing production values and bindings.
For local tests only, use `.dev.vars` (ignored by Git).

**Important:** the checked-in Wrangler file has an empty `ADMIN_CHAT_ID`, a
literal legacy panel URL and a concrete D1 ID. Reconcile these with the actual
production configuration before ANY approved deployment. Declared Wrangler
variables can override dashboard values. This delivery did not change that file
or any production setting. Never overwrite `PASARGUARD_API_KEY` during setup.

The HTTPS Worker route must be reachable from Telegram's Web App clients. Open
forms from the bot's private `/panels` web_app button, not a copied generic browser
link: signed Telegram `initData` is required. Complete any BotFather/domain setup
required for your bot's deployment/client. A missing origin or absent initData
fails closed. No browser-based PasarGuard login is used.

## Database rollout

Migrations are versioned and applied **once** through Wrangler's migration
history. Do not rerun raw SQL files manually or rewrite an already applied 0020.

1. Confirm the exact deployment schema and migration history. If the production
   database has divergent manual changes, stop and reconcile them; do not guess.
2. Export/back up D1 and verify recovery access. Also back up the master encryption
   key and original Worker configuration separately.
3. Pause provisioning using existing `settings.provisioning.enabled=false`, and
   drain in-flight creation/renewal/deletion operations and cron activity. A sales
   stop alone does not stop provisioning, renewals or background jobs. Arrange a
   short maintenance window; do not serve old code against the new schema.
4. Run full tests and local/staging migrations. For local D1 only:

   ```sh
   npm run typecheck
   npm test
   npm run db:migrate:local
   npx wrangler deploy --dry-run --outdir /tmp/errf-worker-check
   ```

5. **Only after explicit production approval**, apply the versioned remote
   migration sequence and deploy the corresponding code:

   ```sh
   # PRODUCTION MUTATION — approval, backup and maintenance required
   npm run db:migrate:remote
   npx wrangler deploy
   ```

6. Check `PRAGMA foreign_key_check`, migration history, row counts, balances,
   receipts, referral records and existing service IDs/URLs. Test the legacy
   panel read-only with `/panels` before approving new writes.
7. Restore the previous provisioning enabled setting when authorized. Start with
   legacy selected; add/test each new API-key panel, then explicitly enable/select.

### What 0020 does

The previously delivered `0020_multi_panel.sql` is unchanged. It adds durable
panel selection, order assignments, policy snapshots, expiry targets, audit,
admin sessions and operation leases. It keeps the old globally unique external-ID
column as `legacy_pasarguard_user_id`, adds the authoritative raw
`pasarguard_user_id`, and uses `(panel_id,pasarguard_user_id)` uniqueness.
Pre-0020 orders, including pending records, are pinned to legacy. New unassigned
orders are pinned when their first provisioning claim begins.

### What 0021 does

`0021_dynamic_api_key_panels.sql` removes the two-ID registry restriction and
obsolete password/token columns. It rebuilds ONLY the small `panels` registry,
not orders or any customer/financial table. Child NO ACTION references are
briefly deferred; an explicit foreign-key integrity guard must succeed before
releasing deferral and committing. No cascaded child records are deleted.

If 0020 was previously activated with a password-authenticated secondary panel:
- Its ID, origin, name, groups and all order/service associations remain unchanged.
- Its obsolete credentials/tokens are removed, and NEW creation is disabled.
- The selection returns to legacy if it pointed at that password panel.
- Reconfigure that SAME panel ID through Edit using its API key; do not add a new
  ID for existing services. Until reconfigured, its service operations fail
  closed; they never fall back to legacy. Plan this step within maintenance.
- Old encrypted credentials may remain in backups; handle/revoke them according
  to your existing secret-retirement policy. The bot will not submit them again.

Registry triggers prevent origin changes once ANY order references a panel, and
prevent deletion of legacy, selected or associated panels. The existing immutable
order-panel trigger stays in force.

## Telegram administrator workflow

1. Send `/panels` in your private bot chat.
2. Use **Add API-key panel securely**. The bot opens a five-minute, actor-bound,
   one-use HTTPS Mini App session.
3. Enter a recognizable name, the public HTTPS origin, the panel's group IDs
   (comma-separated) and its API key. The key field is masked and not prefilled.
4. Submit. The server verifies signed/fresh Telegram initData and authorized user
   ID, validates URL/key/groups, then tests authentication, declared permissions
   and groups BEFORE storing the encrypted key. Failed tests leave the registry
   unchanged (only sanitized audit results are retained). Reopen a fresh form
   after a failed/expired submission.
5. New panels start **disabled for new orders**. Confirm Enable, then Select. A
   successful selection is persisted in D1 and survives later requests/restarts.
6. Test anytime. The menu shows the selected panel, eligibility, configuration
   readiness and latest test status/time. Test status is a snapshot, not continuous
   health monitoring. Keys are shown only as hidden/encrypted, never revealed.
7. Edit a dynamic panel's name/groups/key. Blank key means retain the stored key.
   Replacement keys are tested before replacing the ciphertext. Editing the
   origin is permitted ONLY when no orders of any state reference the ID.
   Once associated, register a separate destination rather than repointing it.
8. Disable stops **unassigned NEW provisioning**; original-service management and
   previously assigned operations remain possible. If the selected panel is
   disabled, new unassigned orders stay unprovisioned until an explicit decision.
   No automatic switch or fallback occurs.
9. Delete only after selecting another destination, and only if the panel has NO
   order associations, including historical/failed/pending/renewal records.
   Deletion is confirmed and guarded transactionally; concurrent assignments
   prevent it. Legacy cannot be deleted. For associated panels, use Disable as
   safe retention/archival. There is intentionally no automatic reassignment.

The legacy panel may be renamed, tested, enabled/disabled and selected. Its URL
and API key remain in their existing Worker configuration and are not editable
through the dynamic credential form.

## Routing, retries and failures

All creation paths use `provisionOrder`: admin payment approval (`src/admin.ts`),
wallet-paid purchase (`src/handlers/purchase.ts`), free trial
(`src/handlers/freeTest.ts`), explicit failed-order retry
(`src/handlers/provisioning.ts`) and bounded cron recovery. The project has no
separate bypass that creates a PasarGuard user directly outside this funnel.

A serialized D1 claim stores stable panel ID, group/policy snapshot, username and
absolute create-expiry target before remote creation. Concurrent selection/config
changes lose the guarded claim instead of redirecting it. Newly selected panels
control subsequent unassigned provisioning claims, not already assigned retries.

Renewal/repurchase/reset/status/deletion/subscription URLs and paid/trial usage
sweeps resolve the originating service panel. Disabling new orders does not
remove that registry row or forbid these management calls. Expiration notices
retain the correct service/URL data; usage refreshes query the pinned panel.

Remote writes are NOT automatically replayed. An uncertain create is reconciled
by its deterministic username plus stored identity/order note before retrying.
Absolute expiry/quota targets are reused. Uncertain usage resets require operator
review rather than a blind second reset. Service mutation leases are 15 minutes;
abandoned operations become visible in `/failed`, preserving assignment/targets.

Dynamic-panel 404s must match the supported user-absence response; a proxy HTML
404, 401, 403, parse failure, wrong external ID or surviving renamed user is NOT
evidence of deletion. No failure causes cross-panel fallback.

## Credential and destination security

- API keys use AES-256-GCM through Web Crypto, unique random 12-byte nonces, and
  authenticated context binding to **panel ID, revision, HTTPS origin and purpose**.
  Moving ciphertext or editing its origin without re-encryption fails closed.
- The master key stays in a Worker secret, never in D1. Legacy's API key stays in
  its original secret. Runtime plaintext is limited to the authenticated request
  and fetch header; no plaintext token/password cache exists.
- Do not send keys through ordinary Telegram messages/callbacks or URL parameters.
  Forms have no analytics or local-storage credential persistence; fields are
  cleared after submission, responses are no-store, CSP-constrained and redacted.
- Usernames/passwords/query credentials, IP literals, non-HTTPS origins, alternate
  ports, paths and local/internal hostnames are rejected. HTTP redirects are errors.
- Before EACH dynamic API call, public DNS A/AAAA answers are checked through
  bounded Cloudflare DNS-over-HTTPS requests; any private, reserved or mixed
  answer fails closed BEFORE the key is sent. DNS failure is not panel fallback.
- DNS preflight and Worker fetch are separate resolutions. This is **not** an
  atomic DNS-pinned egress firewall. Only allowlisted numeric administrators can
  choose destinations; trust their panel DNS/TLS ownership. Do not point panels
  at attacker-controlled DNS or shared/untrusted reverse proxies. If your threat
  model requires protection against a malicious authorized administrator/DNS
  rebinding, use an independently enforced egress proxy policy; not included here.
- Audit stores actor, panel ID, action/result and timestamps, not key material,
  raw exceptions or upstream responses. Failed management authorization is logged
  with numeric IDs/codes, not the supplied callback body.
- Per-panel API-key rotation is supported through Edit (test, encrypt, CAS replace).
  Master-key rotation is a separate approved decrypt/re-encrypt operation; simply
  changing the master secret breaks stored keys. No automatic master rekey tool
  is included. Backups require both D1 data and the corresponding master key.
- Deleting an unassociated panel removes its current ciphertext, not historical
  backup copies or the upstream key. Revoke retired API keys at their panel.

## Limits and operations

Two DNS checks plus one panel request are used per dynamic API call. Each DNS
request has a five-second deadline, each panel request 15 seconds, response reads
are bounded, and there are no automatic write retries. Group tests can use up to
50 group reads. Size the Worker plan/subrequest budget accordingly; a large
multi-panel/service deployment should use Workers Paid and appropriate CPU,
subrequest and D1 capacity. Registry capacity is not a throughput guarantee.
Existing notification batches are bounded; monitor cron completion and backlog.
The current bot has no queue/Durable Object rewrite or automatic health failover.

## Rollback and recovery

Back up BEFORE migration. Do not deploy the original single-panel code after
0020, nor the previous password implementation after 0021: both expect incompatible
schema. Once multiple-panel services exist, rollback must remain panel-aware.
A restore of a pre-change database can lose newer orders and assignments, so it
requires explicit recovery planning and remote-resource reconciliation. Prefer a
forward fix while preserving panel IDs, ciphertext/master key and pinned orders.

Never reassign or recreate services as a workaround for missing credentials or an
outage. Restore the matching credentials/master key for their original panel and
use the existing failed-operation reconciliation workflow.
