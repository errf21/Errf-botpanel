# Safe validation: localized migration and PasarGuard 5.4.1

This guide describes checks to perform later. No staging or production migration, deployment, secret change, or live API mutation was performed while preparing this release. Obtain separate authorization before deploying a staging Worker or running any real migration. Never use production customer services for destructive tests.

## What changed / what remains the same

Migration messages now use the existing `ctx.ui`, `uiFor()` and shared `Texts` bundles. The existing **🌐 زبان / Language** button stores each user's explicit preference in `customers.language`; no new language picker exists. Persian remains the default even if Telegram supplies an English language hint. Commands/callbacks follow the administrator's saved language; customer handoff notices follow the customer's saved language, including scheduled retries. IDs, URLs and technical values use Unicode directional isolation for readable Persian mixed text; storage and callbacks remain unchanged. Exact absolute expiry is shown as a UTC ISO timestamp.

The existing finite entitlement model, source identity, destination identity, atomic cutover, explicit source deletion, history, money, service locks, nonce ownership, credential encryption and no-fallback rules remain intact.

Dynamic destination groups come directly from the numeric IDs saved through the existing visual selector. Legacy destination groups still come from the original shared provisioning configuration. The groups are captured in the migration's immutable reviewed configuration, shown on the review card, and sent in `UserCreate.group_ids`. There is no separate migration group override. Editing the panel defaults after review affects future drafts, not an existing confirmed migration. Cancel and recreate a draft if different groups are intended.

The Worker now checks that captured groups can be read and are enabled before draft creation and before provisioning/activation. Missing, disabled, malformed or inaccessible groups block progression, never selecting alternative IDs. Destination read-back must contain the same numeric group ID set. A mismatch blocks cutover. Group checks have a 30-second validation budget checked before/after reads; a final in-flight DNS/API call can finish just beyond that budget, but no subsequent creation/activation is allowed on an expired budget. Slow or large group configurations may therefore remain blocked until a retry; check Worker plan subrequest limits and staging behavior for the intended group count.

A disabled selected group is also rejected during secure panel configuration verification. The visual selector itself and its localization/security shell are otherwise unchanged.

## Versioned API evidence

Public PasarGuard tag **v5.4.1** resolves to commit **b56ffe369f542152c52c69733205baeaf3f6e4cd**. This is the same pinned commit previously inspected for group discovery, now explicitly tied to the release tag. Source locations and downloaded-file SHA-256 values are recorded in `docs/evidence/pasarguard-5.4.1-contract.json`.

Verified source contracts:

| Operation | Contract | Permission |
|---|---|---|
| Group discovery | GET `/api/groups?offset=...&limit=100`; `{groups,total}` | `groups.read` |
| Selected group validation | GET `/api/group/{id}`; numeric id and boolean is_disabled | `groups.read` |
| Create user | POST `/api/user`; group_ids, bytes quota, absolute expire, hwid_limit | `users.create` |
| Read stable identity | GET `/api/user/by-id/{id}` | `users.read` |
| Staging / activation | PUT `/api/user/by-id/{id}` | `users.update` |
| Delete source | DELETE `/api/user/by-id/{id}` | `users.delete` |

API keys use `X-Api-Key`; no username/password login or bearer acquisition was added. User responses include numeric `id`, `group_ids`, `used_traffic`, `data_limit`, `hwid_limit`, `subscription_url`, and expiry which may be returned as an ISO timestamp. UserCreate supports active/on_hold, not disabled; the existing create-active-then-disable staging strategy is preserved. Migration cleanup deletes the source user; it does not call `revoke_sub` merely to rotate its URL.

Panel configuration also retains its existing requirement for declared `users.reset_usage`, because normal lifecycle operations need it. Definitive source/candidate absence requires freshly verified owner or ALL-user read scope. OWN-scoped invisibility, proxy 404, timeout and authentication failure are not absence proof.

This is public source inspection and synthetic wire-contract testing, NOT a live 5.4.1 runtime or OpenAPI server test. Verify the actual staging installation's version, permissions and endpoint behavior independently.

## Configuration / release boundary

No new dependency, secret, variable, Cloudflare product or SQL migration is needed. Preserve all existing settings, especially `PANEL_ENCRYPTION_KEY`: do not rotate or replace it. Existing encrypted API keys must remain decryptable. The current source expects the existing schema through migrations **0001–0024** (29 application tables); this phase adds no migration. On a separately authorized fresh staging installation, use Wrangler's versioned transactional migration mechanism, not raw autocommit replay. Never repeat released SQL files blindly.

Use a separate staging bot token, webhook secret, staging D1 binding and disposable panels. For staging, configure the existing `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_CHAT_ID` and/or comma-separated `PANEL_ADMIN_IDS`, `PANEL_ADMIN_ORIGIN`, `PANEL_ENCRYPTION_KEY`, and legacy `PASARGUARD_PANEL_URL` / `PASARGUARD_API_KEY` according to the existing release guides. These are existing settings, not additions. Keep the five-minute Cron functional. Do not copy or alter production secrets. `PANEL_ADMIN_ORIGIN` must be the staging Worker HTTPS origin. Panel/migration access is private-chat-only and uses the explicit numeric allowlist, not just general D1 administrator status.

Migration remains command-driven: there is no new migration button inside `/panels`. Do not roll back after an active migration to a Worker that reads raw source orders instead of `effective_orders`. Do not drop migration/resource tables as a rollback. Use a compatible forward fix and retain source/resource/audit evidence.

## Safe staging checklist — only after separate authorization

### 1. Verify language and authorization

1. In a private staging-bot chat, use **🌐 زبان / Language** to select Persian; repeat later in English.
2. Use a separate ordinary-user account to try `/panels`, `/migrate`, and reused/copied callback buttons. Access must be rejected server-side.
3. Verify unsigned/stale Mini App requests cannot retrieve metadata/groups; a form link alone must not authenticate a requester. Missing bot-token configuration must fail closed (test in an isolated staging configuration only).

### 2. `/panels` and the visual selector

1. As an authorized staging administrator, send `/panels` and choose Add API-key panel securely.
2. Enter the disposable panel's public HTTPS origin/key only in the Mini App, never in ordinary Telegram chat or source files.
3. Confirm actual group names load. Select individual groups; verify the count and Select All checked/indeterminate behavior. Deselect all: saving must be disabled.
4. Save a small known set (for example two actual discovered groups, not invented IDs). Reopen Edit and verify preselection by ID.
5. Test empty list, groups.read denial, rejected key and a disabled/deleted selected group using disposable configuration. No arbitrary group fallback or successful save should occur; previous accepted configuration must remain intact when validation fails.
6. Restore valid groups, Test, and explicitly Enable the destination. Migration does not require changing the global new-order default. Do not repoint the original legacy URL to switch panels.
7. Verify no stored key/ciphertext is returned to the browser and keys are absent from messages/logs. Retained keys must not be sent to an edited host.

### 3. `/migrate` successful flow

1. Create a disposable, completed purchase service for a staging customer. Do not use a free trial or any production customer. Stop its test client's traffic while preview/confirmation is being compared.
2. Record source remote ID, panel, quota, used bytes, absolute UTC expiry, device limit, subscription URL, wallet balance and financial/order history.
3. Send `/migrate <customer_numeric_Telegram_ID>`. Press the service button, then **Migrate to <panel>**. Destination pages contain five panels; use the displayed `/migrate panels <service_ID> <page>` command (zero-based page).
4. Review source/destination IDs, captured destination groups, evidence type, remaining bytes and expiry. Fresh remaining bytes must equal `data_limit - used_traffic`; destination expiry must remain the original absolute time, not a new duration.
5. Confirm within 60 seconds for fresh data. If source usage/expiry/device limit changed, the draft must reject confirmation; cancel it and review again.
6. At `verified`, confirm destination exists with the correct ID marker, groups, remaining quota, expiry and devices and is disabled. The bot must still show the source as active.
7. Press Continue verified activation, or observe the next five-minute scheduled recovery. At `cleanup_pending`, the bot must use the destination and persist the correct activation-time subscription URL. Customer notification must use that customer's saved language and stamp delivery only on Telegram-confirmed success.
8. Independently test the disposable destination subscription URL with a real client, including group/inbound availability and device-limit behavior. API read-back alone does not prove connectivity.
9. Verify no wallet debit, new payment/order, lost historical order or altered customer identity.
10. Only after verifying destination usability, press Review source revocation, verify the displayed original stable ID/panel, then Confirm source revocation. This intentionally deletes the disposable source user. `completed` requires certified source absence, not an uncertain response. Confirm the old test subscription actually stops working; API absence alone is not live traffic verification.

Persian buttons display localized equivalents such as «ادامه فعال‌سازی مقصد تأییدشده»، «بررسی لغو سرویس مبدأ» and «تأیید لغو سرویس مبدأ». `/migrate status <migration_ID>` and Refresh progress show durable state in the current administrator's saved language.

### 4. Recovery / negative scenarios

- Make only the disposable source unavailable. A fingerprint-matching saved observation must be marked stale, not fresh. Without trustworthy values, no automatic entitlement transfer proceeds. Use `/migrate manual <migration_ID> <remaining_bytes> <YYYY-MM-DDTHH:mm:ssZ> <devices>` only with independently justified values, then explicitly confirm the manual review.
- Leave source revocation unconfirmed if unreachable. The old service may remain usable; the bot must warn accordingly. It must not delete a source merely because destination creation was attempted.
- Interrupt creation after an uncertain response; retry must reconcile the deterministic destination identity before another POST, not create a second username or use another panel.
- Retry missing/unavailable destination groups, invalid group read-back or invalid URL. No local cutover or source deletion is permitted until verification succeeds.
- Interrupt after disabled staging or remote activation but before local cutover. Recovery must verify identity and the latest URL before committing the active resource.
- Repeat confirmation callbacks and run overlapping recovery in isolated staging. Verify one active migration per service, no cross-customer assignment, no duplicate destination, and unchanged financial history. Local SQLite tests do not prove real distributed D1 concurrency.
- Before cutover, test Review abort → Confirm safe abort. Only the unpublished destination may be cleaned up; uncertain abort remains pending and cannot be activated by recovery.
- Cause a Telegram notification timeout/error. It must remain unstamped and recover later. A crash after Telegram accepted but before local stamp can repeat a notice: delivery is at-least-once, not exactly-once.

## Remaining limitations

Finite fixed entitlement only; no full proxy/reset/next-plan clone, no trial migration, no atomic cross-panel consumption freeze. Stale/manual values require explicit administrator judgment. Source may remain usable until separately revoked. Subscription connectivity, node-side revocation propagation, real Telegram RTL/link behavior, actual API-key scopes and Worker/D1 concurrency must be checked in controlled staging. Large group counts add per-group API/DNS subrequests and may hit the Worker plan's limits or validation budget; failures remain blocked/recoverable, not successful migrations. No new Cloudflare product is introduced to bypass those limits.
