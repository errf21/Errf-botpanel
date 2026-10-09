# Reliability delivery — future approved Cloudflare release checklist

This is an operator checklist, not an executed release. The current task did not deploy or touch production. Review `RELIABILITY_DELIVERY_REPORT.md` and the patch against the exact **592-test audited baseline**. Preserve the existing multi-panel and subscription-migration implementation.

## Configuration/resource inventory

**No new secret, variable, Cloudflare product or external service is introduced.** The new work uses the existing Worker, D1 binding and five-minute cron. “Existing” below means present in code; production configuration has not been inspected.

| Item | Cloudflare destination | Required action |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Workers & Pages → intended `errf-botpanel` environment → Settings → Variables and Secrets → Secret | Preserve valid existing token. Strict delivery method uses this same secret; no new token. Mini App missing/blank-token failure remains closed. |
| `TELEGRAM_WEBHOOK_SECRET` | Same Worker → Variables and Secrets → Secret | Preserve exact existing webhook secret and matching Telegram header. |
| `PASARGUARD_API_KEY` | Same Worker → Variables and Secrets → Secret | Preserve original legacy panel API key unchanged. |
| `PANEL_ENCRYPTION_KEY` | Same Worker → Variables and Secrets → Secret | Preserve existing base64 32-byte encryption master key; no rotation/replacement/re-encryption in this release. Back up separately from D1. |
| `PAYMENT_CARD_NUMBER` | Same Worker → Variables and Secrets → Secret | Preserve if card payments are used; unchanged. |
| `PASARGUARD_PANEL_URL` | Same Worker → Variables and Secrets → Text; reconcile `wrangler.jsonc.vars` if CLI deployment | Preserve original legacy origin; do not repoint to switch panels. |
| `ADMIN_CHAT_ID` | Same Worker → Variables and Secrets → Text / reviewed Wrangler vars | Preserve/reconcile intended positive numeric Telegram USER ID. Checked-in Wrangler value is empty; declared vars can override dashboard values. |
| `PANEL_ADMIN_IDS` | Same Worker → Variables and Secrets → Text | Existing optional comma-separated allowlist; preserve if used. Union with `ADMIN_CHAT_ID` for panels/migration. No new administrator setting. |
| `PANEL_ADMIN_ORIGIN` | Same Worker → Variables and Secrets → Text | Preserve existing HTTPS Mini App origin. Not a new announcement setting. |
| `SUPPORT_CONTACT` | Same Worker → Variables and Secrets → Text | Optional existing support setting; preserve if used. |
| `DB` binding | Same Worker → Settings → Bindings → D1 | Preserve intended `telbot-db` database/environment and binding `DB`; do not create/replace the database. |
| `*/5 * * * *` cron | Same Worker → Settings → Trigger Events / Cron Triggers; `wrangler.jsonc.triggers.crons` | Required existing schedule; preserve and verify enabled. It now also resumes broadcasts and orphan checkout reservations. No second cron. |
| Existing domain/webhook route | Same Worker → Settings → Domains & Routes | Preserve HTTPS origin, `/telegram/webhook`, and Mini App endpoints. No new HTTP route. |
| `nodejs_compat`, compatibility date | Reviewed `wrangler.jsonc` | Preserve current reviewed build settings; unchanged. |
| Migration `0023_reliability_delivery.sql` | D1 → intended database; apply using reviewed versioned Wrangler migrations workflow | New required additive migration after 0022 and before this Worker version. No production application occurred. |

Do not add announcement API credentials, username/password login secrets, queues, Durable Objects, extra services, a new DB, per-panel environment variables or invented enable flags. There is no new code-level broadcast maintenance flag; coordination of a release window must be deliberate, not pretending such a switch exists.

## Release sequence — approval and staging first

1. Review exact baseline patch, schema and full test evidence. Confirm backups/restore of the existing D1 database and encryption key independently. Review historical duplicate wallet-payment-token conflicts before approving production migration; do not “fix” them by deleting financial records.
2. Stage this entire source tree with isolated Worker/D1 bindings and synthetic Telegram/panel credentials. Do not use real customer broadcasts as a test.
3. Coordinate a maintenance window for announcement creation/sends and checkout writes. Stop new announcement starts and old scheduled delivery invocations in the approved environment, and wait for old in-flight Workers to drain. Pausing a cron alone does not stop webhooks/manual old broadcast callbacks: account for both. These configuration/actions require separate authorization.
4. Apply 0023 **before** activating the new Worker. Local validation command used the equivalent of:
   `node node_modules/wrangler/bin/wrangler.js d1 migrations apply telbot-db --local --config <isolated-config> --persist-to <isolated-state>`
   An eventual remote command must name the separately verified environment/config/database. No production command is authorized or executed by this document.
5. Do not continue rollout if the unique payment-token backfill fails. Versioned Wrangler migration tracking prevents reapplication; running raw 0023 SQL twice is not supported. Transactional rollback on conflict preserves records.
6. Activate only the reviewed new Worker after migration success, then restore the existing five-minute cron and approved webhook traffic. Do not overlap old/new announcement implementations: the old sweep may reclaim new valid leases.
7. Keep migration/state columns and history. An old Worker may accept the additive schema but has unsafe old announcement/refund semantics; do not blindly revert to it after new work starts. Prefer a compatible forward correction. Schema removal is not a safe data rollback.

## Post-release verification on staging

- Confirm unauthorized webhook/administrator/Mini App access still fails; existing authenticated metadata, blank-token failure, session ownership, nonce and replay regression behavior is preserved.
- Verify two concurrently funded distinct orders yield both ledgers and correct balance; duplicate retry charges once; insufficient funds never go negative; order insert requires matching claim. Verify late order cannot consume an already-compensated claim.
- Verify synthetic pre-order interruption refunds only after the 15-minute threshold; linked historical order with no idempotency key must not be refunded. No historical automated repair is implied.
- Confirm migration customer handoff API rejection/timeout leaves delivery pending; only confirmed message ID stamps delivery. Repeat execution after stamp does not send again. Uncertain acceptance remains at-least-once.
- Start a synthetic announcement to more than 20 recipients. Confirm it continues by cron without administrator taps, shows sent/failed/pending/active/retryable/delayed/seeding, and settles only after all captured recipients are terminal.
- Observe recipient ownership across overlapping invocations, expired lease recovery, interruption after send, blocked recipients, 429 `retry_after` pause/resume, and configuration-error pause. Check secrets/raw error descriptions never appear in stored errors/output.
- Verify cron is actually firing and combined scheduled workloads fit the target Cloudflare plan. Conservative maximum is 40 attempts per five-minute sweep plus initial pass, not instantaneous full-audience delivery. Test actual latency/subrequest/CPU limits; do not silently increase fan-out.
- Compare customer balances, orders, payments, wallet ledgers, referrals, migration state, active service resources and historical events before/after representative staging operations; run FK and backup/restore checks.
- `/health` is not a proof of delivery, panel connectivity or migration correctness. `/announcements` is the status view; cron-only completion has no newly guaranteed proactive end notice.

Await a separately authorized staging/release decision. This implementation task did not perform these production steps.
