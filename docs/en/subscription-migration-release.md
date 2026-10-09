# Subscription migration — operator guide and Cloudflare release checklist

## What this release does

An explicitly allowlisted administrator can move a completed customer service between enabled PasarGuard API-key panels. No replacement payment or order is fabricated. The original purchase, customer, wallet, payment, referral and usage/event history remain intact; `active_service_resources` supplies the current resource to `effective_orders` and service operations.

This guide is for a future approved release. **Nothing has been deployed or applied to production by this implementation task.** Use isolated staging first. The checked-in Worker name is `errf-botpanel`, D1 binding is `DB`, database name is `telbot-db`; actual account/environment values must be reconciled by the operator.

## Telegram workflow

1. In private chat, `/migrate <customer numeric Telegram ID>` lists their latest ten active logical services. An administrator may also use `/migrate panels <known service ID> [page]`; destination lists are five per page.
2. Select the service and an enabled, tested destination. The bot takes a read-only source preview and displays customer identity, both panels, destination groups, remaining **bytes**, absolute UTC expiry and device cap.
3. Read the provenance: **fresh verified**, **STALE saved**, or **MANUAL**. A complete finite entitlement is mandatory. Missing/unlimited/relative/unsupported data stops automatic migration; nothing is invented from purchased quota alone.
4. When necessary, enter non-secret values with `/migrate manual <migration ID> <remaining_bytes> <YYYY-MM-DDTHH:mm:ssZ> <devices>`. This is not credential entry. Manual input requires a new explicit confirmation. It represents a fixed finite entitlement; custom reset/next-plan/proxy features are not cloned.
5. Confirm. Fresh previews expire after 60 seconds and are re-read before acceptance; changed/unavailable values require review again. General drafts/selection/revocation/abort choices expire after five minutes.
6. Destination creation and staging finish at durable `verified`: the original remains active in the bot and the new resource is verified disabled. Select **Continue verified activation**, or let a later cron invocation resume activation.
7. Once `cleanup_pending` is persisted, the destination is active in the bot. A customer handoff message is sent/retried only for the currently active generation. The customer can also retrieve the URL from their existing service card.
8. Separately select **Review source revocation**, then confirm. Only the captured source stable ID is targeted; a certified by-ID absence is required before recording revocation. An unavailable source stays **NOT CONFIRMED** and may remain usable. PasarGuard can hide users behind an OWN-scope 404: cleanup requires a freshly verified owner or ALL-user read permission, not merely a “User not found” body. Restricted scope leaves cleanup unconfirmed.
9. `/migrate status <migration ID>` shows durable progress. Retry reconciles before creating/writing. Before cutover, **Review abort** can reconcile/delete only the unpublished candidate and keep the original service. An uncertain abort has a durable flag preventing cron activation until cleanup is resolved.

A pending source cleanup does not prevent a later migration away from the newly active panel. Archived cleanups are independent and refuse to revoke whichever resource is currently active.

## Entitlement accuracy and operational precautions

Fresh values are verified again at confirmation; quota transfer is `quota - used`, with the **same absolute expiry**, not a new duration. Device limits and destination groups are recorded and verified. Negative/unknown/exhausted traffic, expired/unlimited expiry or unknown device caps are not guessed.

The panels do not offer a distributed transactional transfer of metered traffic. Source traffic can advance after the final read, and an unrevoked source may continue to work. The UI explicitly displays the snapshot timestamp and warns about this; stale/manual confirmation expressly accepts uncertainty. **For strict live conservation, coordinate an operator-controlled source traffic pause/quiescence and fresh measurement before transfer. Do not promise atomic quota conservation while both sources can be used.** This release does not automatically pause the source or carry unsupported reset/next-plan policies. Do not turn an uncertain legacy unlimited/periodic plan into a finite plan without explicit entitlement review.

Migrated lifecycle operations also reject scoped/uncertified 404s instead of marking the active service deleted. Source revocation and candidate abort reconcile by stable ID, then require fresh `/api/admin` evidence of active owner/ALL-user read access before confirming absence. The original non-migrated legacy endpoint behavior is retained, not broadly repaired.

Trustworthy observations begin with this release. If an offline service has no verified observation, original order price/quota is not enough to invent remaining usage: explicit administrator review is necessary. A saved observation includes origin, panel, external ID, username and timestamp, and cannot be used for another resource or repointed origin.

## Cloudflare configuration inventory

No **new** secret or ordinary variable is introduced by subscription migration. The following existing items must be preserved or reconciled. Production values were not inspected, so “existing” means existing in the implementation—not proof they are configured in your account.

| Item | Kind / destination | Action for approved release | Purpose and validation |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret; Cloudflare Workers & Pages → `errf-botpanel` → Settings → Variables and Secrets | **Preserve existing valid token.** Add only if genuinely missing. Do not rotate for migration. | Telegram delivery and existing Mini App HMAC verification. Missing/blank token continues to fail Mini App authentication closed. |
| `TELEGRAM_WEBHOOK_SECRET` | Secret; same Worker Variables and Secrets | **Preserve.** Do not change Telegram webhook secret independently. | `/telegram/webhook` requires matching `X-Telegram-Bot-Api-Secret-Token`; missing/mismatched requests are rejected. |
| `PASARGUARD_API_KEY` | Secret; same Worker Variables and Secrets | **Preserve original key exactly.** No replacement required. | Legacy API-key authentication remains `X-Api-Key`. |
| `PASARGUARD_PANEL_URL` | Ordinary text variable; same Worker Variables and Secrets; reconcile `wrangler.jsonc.vars` for CLI deployment | **Preserve original origin; never repoint to switch panels.** | Legacy connection. Migration source/destination origins are captured; migrated-service operations reject origin changes. Historical legacy provenance still needs operator verification. |
| `PANEL_ENCRYPTION_KEY` | Secret; same Worker Variables and Secrets | **Preserve existing master key.** If multi-panel setup never configured it, add once before using dynamic panels. | Base64 of exactly 32 random bytes, AES-256-GCM for registry API keys. Back up separately from D1. Never replace a key already encrypting rows without a reviewed re-encryption process. |
| `ADMIN_CHAT_ID` | Ordinary variable; same Worker Variables and Secrets / `wrangler.jsonc.vars` | **Reconcile to authorized positive numeric Telegram USER ID.** Checked-in value is empty. | Required if this is the sole administrator. Must not be a group/channel ID. |
| `PANEL_ADMIN_IDS` | Optional ordinary variable; same destination | **Preserve or add only for explicitly trusted additional admins.** | Comma-separated canonical positive numeric Telegram user IDs. Union with `ADMIN_CHAT_ID`; empty union fails closed. D1 `is_admin` alone is insufficient. |
| `PANEL_ADMIN_ORIGIN` | Existing ordinary variable; same destination | **Preserve correct HTTPS Worker origin**, or add if existing panel Mini App management has not been configured. | Existing `/panels` credential-management form and authenticated metadata/configuration POSTs. Migration commands do not require a new origin or Mini App. |
| `PAYMENT_CARD_NUMBER` | Existing secret; same Worker Variables and Secrets | **Preserve when card payments are used.** | Existing seller-card payment instructions. Migration does not use or change it. |
| `SUPPORT_CONTACT` | Existing optional ordinary variable; same destination / Wrangler vars | **Preserve if used; not required for migration.** | Existing support button. |
| `DB` | D1 binding; Worker Settings → Bindings (or Add binding → D1 Database) | **Preserve correct existing database**, `telbot-db` in repository. | All customer/financial/service/migration persistence. Verify real database ID/environment rather than creating a new production database. |
| Worker origin/routes | Worker Settings → Domains & Routes; existing domain/workers.dev endpoint | **Preserve existing HTTPS route and Telegram webhook endpoint.** | `/telegram/webhook`, `/health`, existing Mini App paths. No new migration HTTP route or browser login. |
| Cron `*/5 * * * *` | Existing Worker Settings → Trigger Events / Cron Triggers; `wrangler.jsonc.triggers.crons` | **Preserve existing five-minute cron.** | Migration recovery/notification handoff, existing panel recovery and payment/service reminders. No second cron required. Dashboard labeling may vary. |
| Compatibility settings | `wrangler.jsonc` | **Preserve** `nodejs_compat` and current compatibility date for this reviewed build. | Web Crypto/fetch/D1 runtime. No dependencies were installed or upgraded. |
| Observability | Existing Worker observability configuration | **Preserve and review redaction/access controls.** | Only internal stage/error codes are logged. Do not enable credential/body dumps. |

**Not required:** per-panel environment bindings, panel username/password, bearer-token secrets, `SERVICE_MIGRATION_ENABLED`, new encryption keys, a new migration origin or a new database. There is no new migration kill-switch setting to configure. Do not invent any of these.

Dashboard section names can vary; use the named Worker and named binding/secret destinations above. Public Cloudflare documentation could not be reloaded in this session (HTTP errors), and no authenticated dashboard was inspected. These are configuration destinations, not claims that production settings were verified.

### Configuration safety before deployment

- The checked-in Wrangler vars contain **empty `ADMIN_CHAT_ID`**, a concrete legacy URL and concrete D1 ID. Reconcile with the intended environment; declared vars can override dashboard values. `keep_vars` does not authorize overwriting explicitly declared values.
- Never paste real panel keys or the encryption master key into source, Git, ordinary chat, command arguments or reports. New panel keys continue to enter through the existing authenticated HTTPS Telegram form.
- Secret writes can publish/create Worker versions. Even preparatory `wrangler secret put` requires separate authorization and a reviewed version workflow. No such write was executed here.
- Preserve existing D1 settings documents, catalog/pricing/payment/wallet flags and provisioning groups. Shared provisioning must already be valid/enabled; dynamic destination groups must be valid and declared permission checks passed.

## Database migration and release sequence

**Required new migration: `migrations/0022_service_migrations.sql`.** Leave 0020 and 0021 unchanged. This is additive: new migration/events/resource/observation/choice tables, constraints/triggers and an `effective_orders` view; it neither rebuilds nor rewrites existing financial/order tables.

1. Review the exact patch against the **529-test local baseline**, not vanilla GitHub HEAD.
2. Back up D1 and the existing encryption key independently; test restore and inspect existing panel provenance and pending operations.
3. Stage on isolated Worker secrets/bindings and a copy/fixture database. Preserve all existing settings.
4. Apply 0022 **before** deploying the new Worker to that environment. For the approved target, use the repository's Wrangler migration mechanism with an explicitly reviewed environment/database:
   - Local only: `node node_modules/wrangler/bin/wrangler.js d1 migrations apply telbot-db --local`
   - Eventual approved remote action: `node node_modules/wrangler/bin/wrangler.js d1 migrations apply telbot-db --remote` **with the correct reviewed environment/config**.
   - Production execution is NOT authorized by this guide. Do not run a generic command against an unverified default database ID.
5. Wrangler `d1_migrations` records versioned application. Repeat Wrangler invocation is safe/no-op; raw SQL scripts are intentionally not rerunnable. D1/SQLite transaction rollback of the schema was locally tested.
6. Deploy/promote the reviewed Worker version only after authorization and staging acceptance.

The new code expects 0022 tables/view to exist; do not deploy it first. An old Worker can operate on the additive schema **before the first migrated active resource exists**. **After a migration cutover, do not roll back to the 529-test Worker**: it reads raw historical source identities. Use a view-aware forward fix/compatible rollback or a separately validated recovery procedure. Dropping resource/migration tables is not a safe rollback; it can strand customers or send operations to revoked sources.

## Post-deployment verification, staging first

- `/health` checks configured booleans only; it does **not** prove panel connectivity, permissions or migration readiness.
- Confirm the webhook rejects missing/wrong secret headers. Confirm ordinary users and D1-only admins cannot invoke migration callbacks or `/migrate`.
- Re-run existing panel Mini App regressions on staging: generic unauthenticated shell, authenticated-only metadata, fresh signed initData, blank-token fail-closed and one-use actor-bound configuration nonce.
- In private authorized chat, `/panels`: inspect registry/default; test source/destination declared user permissions and groups. Verify enabled destination, API-key encryption and confidential output.
- Use **synthetic staging customers/services** to verify actual deployed PasarGuard create, PUT by-ID, DELETE by-ID, read-by-ID/username, certified absence semantics and owner/ALL-read versus OWN-read visibility, note/group/device/quota/expiry persistence and subscription URLs. No live panel was tested in development.
- `/migrate <synthetic Telegram ID>` → review → confirm → `verified` (disabled destination, source still active) → continue → `cleanup_pending` (current customer card/new URL is destination) → separately confirm source revocation → `completed` only on certified absence.
- Test source outage with a trustworthy saved snapshot; then with no snapshot/manual values. Check explicit stale/manual confirmation and visible unconfirmed revocation warning.
- Test timeout/restart/duplicate callback at each stage, safe abort before cutover and an unavailable candidate during abort. Abort flag must prevent automatic activation.
- Confirm wallet balances, payment references, original orders, referrals and old usage/events are unchanged by migration. Confirm active binding and FK integrity. Verify renewals/repurchases, resets, status, deletion and notifications route to the replacement even after global default switches.
- Confirm cron resumes verified/interrupted stages and handoff notifications but never automatically reissues an uncertain create or performs source revocation. Notification delivery is at-least-once across a crash after Telegram acceptance.
- Load-test the actual Cloudflare plan, D1/subrequest/API limits and latency. Recovery is bounded to two pending migrations and two customer handoffs per sweep; legacy recovery and notice sweeps also share the Worker budget. Watch append-only observation growth and define a separate reviewed retention policy if needed.

Do not claim production-data safety, live PasarGuard compatibility, atomic cross-panel usage conservation or real-world security certification from the local test suite alone.
