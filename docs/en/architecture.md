# Architecture & Source Map — English

🇬🇧 English · [🇮🇷 فارسی](../fa/architecture.md) · [index](README.md)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Components

```
Telegram user / admin
        │  (long-poll replaced by webhook — HTTPS POST of Update JSON)
        ▼
Cloudflare Worker   ── entry: src/index.ts (fetch + scheduled handlers)
   routes/ ── webhook.ts (auth gate)  health.ts (liveness)
   dispatch.ts ── dedupe → register customer → resolve admin + language → route
   handlers/* ── every flow (buy, payment, services, renewal, wallet, ticket,
                  announce, reminders, notices, pricing, sales, language, guide)
   state/machine.ts ── PURE conversation transition (no I/O, no time)
   catalog/* ── config-doc load+validate (fail-closed/degrade-safe)  ·  pricing
   orders/checkout ── the ONLY place pricing becomes a durable order
   db/* ── every SQL: single guarded statements, batches, CAS, append-only audit
   pasarguard/client ── typed REST (x-api-key, 15s timeout, error kinds)
   provision/* ── the ONLY orchestrator that creates/extends panel services
        │                     │
        ▼                     ▼
  Cloudflare D1         PasarGuard panel API
  (telbot-db): the      (HTTPS, x-api-key): service
  single source of      create / read / extend +
  truth — orders,       subscription URL. Called
  ledgers, audits,      only from provision/*
  settings docs
```

Responsibility boundaries that the code strictly maintains:

- **Handlers** own UX and routing decisions, but *all* decisions that matter
  (authorization, pricing, validation, state claims) are re-checked server-side
  (`ctx.isAdmin`, `ctx.ui`, catalog re-validation — keyboard payloads are never trusted).
- **`db/*`** is the only place SQL lives; **`catalog/*`** the only place config
  documents are read/validated; **`provision/provision.ts`** the only path that
  touches the panel (client.ts is just HTTP plumbing);
  **`orders/checkout.ts`** the only path that creates orders.
- **`telegram/i18n.ts`** is the ONLY language branch in the codebase
  (`uiFor()`), and **`telegram/menu.ts`** the single source for both keyboards
  and the callback vocabulary.

## 2. Update pipeline (every Telegram update, exactly once)

`src/dispatch.ts` — invoked by `routes/webhook.ts` only after the secret-header
check passes:

1. **Dedupe**: the update's `update_id` is registered in `update_dedupe`
   (plain INSERT in try/catch, `db/dedupe.ts`); a webhook replay hits the PK
   violation → dispatch returns before doing anything else, and the webhook
   still ACKs 200 so Telegram stops retrying.
2. **Register**: idempotent customer upsert (`db/customers.ts`, profile fields
   refreshed; `language` is NEVER touched by upsert). First-ever customer gets
   the welcome probe. `ref_*` deep-link arg on a first-ever `/start` is captured.
3. **Resolve** per-update, once: `isAdmin` (`ADMIN_CHAT_ID` env OR
   `customers.is_admin`) and `ui = uiFor(customers.language)` — persisted
   explicit choice only; NULL ⇒ Persian. Telegram `language_code` is stored for
   display, never selects a language.
4. **Route**: command → `handlers/commands.ts`; callback → `handlers/callbacks.ts`
   (validated vocabulary); text/photo/document → `handlers/menuActions.ts` /
   `handlers/messages.ts` → state machine.
5. **ACK 200 unconditionally** (`webhook.ts:44-47`): failures are logged, never
   surfaced as retry-hammer. Long work (provisioning/extension) is deferred to
   `ctx.waitUntil` **after** the ack.

## 3. Conversations & session state

`state/machine.ts` is pure; persistence in `conversation_states` (one row per
customer, 13 CHECKed states, JSON draft payload, 24 h lazy expiry —
`db/states.ts`). Drafts accumulate chosen values; a ULID `order_token` is minted
when the confirmation step appears and later becomes `orders.idempotency_key`.

States: `IDLE, BUYING, WAITING_CONFIG_NAME, WAITING_VOLUME, WAITING_DURATION,
WAITING_DEVICE_LIMIT, WAITING_ORDER_CONFIRMATION, WAITING_PAYMENT_RECEIPT,
WAITING_RENEWAL_DURATION, WAITING_RENEWAL_CONFIRMATION, WAITING_SUPPORT_MESSAGE,
WAITING_ANNOUNCE_TEXT, WAITING_ANNOUNCE_CONFIRM` (`src/types.ts:47-61`).

## 4. Purchase & payment data flow (the core business flow)

```
Buy taps → machine builds draft → checkout prices (integer engine, fail-closed
   catalog coverage) → durable order (batch: orders row + order_created event)
→ payment instructions (D1 payment_info + PAYMENT_CARD_NUMBER secret + snapshotted
   total — customers see ONLY the final amount)
→ customer uploads receipt (photo/document; text ignored)
→ guarded UPDATE pending_payment → awaiting_review; receipt forwarded to ALL admins
→ admin ✅ /❌ (or reminder digest buttons — same code path)
   ✅ approved → (if wallet-paid order: straight to provisioning) ...
   ❌ rejected → reason prompt (admin_actions, 15-min TTL) → single guarded UPDATE,
      winner notifies customer + refunds any applied wallet credit in the SAME batch
→ approved order: manual approve schedules provisionOrder via waitUntil:
   claim approved→provisioning (guarded, max_attempts in the claim itself) →
   pre-check GET by-username → ADOPT existing or POST /api/user → verify →
   completed + subscription_url → customer gets the link; failure → failed +
   admin push + /failed retry (same guarded claim against the cap).
```

Order states are CHECK'd in D1: `pending_payment, awaiting_review, approved,
provisioning, completed, rejected, failed, cancelled`. Renewals ride the *same*
pipeline as `kind='renewal'` orders targeting an existing service row.

## 5. Wallet- & partial-pay path

At the summary step, a customer with balance gets `wlt:full` / `wlt:part` buttons.
Flow (`purchase.ts` + `orders/checkout.ts` + `db/wallet.ts`): the debit is claimed
**against the draft token before** order creation (guarded UPDATE + NOT EXISTS
double-pay backstop + partial UNIQUE index), the order is created with
`amount = remainder` (full-pay orders are **born `approved`**, `verified_by='wallet'`
— no receipt, no admin queue), ledger rows are then re-pointed from token to
order id (`setPaidLedgerOrder`). Any checkout failure path has an explicit
refund claim (`refundOrderWalletPayment`) that cannot double- or lost-refund.

## 6. Scheduled cron sweeps

`src/index.ts:scheduled` — Cloudflare Cron `*/5 * * * *`, two sweeps, isolated
`try/catch`, at-most-once claims in D1 (`db/paymentReminders.ts` stages 1,2,3 =
≥15/30/45 min anchored on first receipt; `db/serviceNotifications.ts` one
`usage90` + one `expiring` notice per **paid** service, plus the one
`free_test_expiring` notice (~2h window, claimed orders only — the paid legs'
candidate SQL excludes them) via composite-PK table + 30-min lease).
Precision of the cron is cosmetic — every guarantee lives in the DB.

## 7. Authentication & authorization boundaries

| Boundary | Mechanism |
| --- | --- |
| Telegram → Worker | `X-Telegram-Bot-Api-Secret-Token` header, constant-time compare, webhook 503-until-configured / 401 mismatch / 400 bad JSON. |
| Actor identity | The authenticated Update's `from.id`; registration is automatic (upsert); **no** session tokens. |
| Admin | `isAdmin` computed once per update; every admin handler **also** re-checks server-side; admin keyboards/callbacks (`adm:`, `tsk:`, `prc:`, `sal:`) are inert to non-admins (neutral toast for forged/foreign payloads). |
| Ownership | `svc:` actions re-check `customer_id` inside the WHERE clause; ULID ids in callbacks are pattern-validated. |
| Worker → panel | `x-api-key`; HTTPS-only base URL validation. Key never logged / never in Telegram text. |
| Callback text-inputs | free-text answers (config name, amounts, reject reason, ticket body) sanitized with hard bounds — [Security](security.md). |

## 8. Database responsibilities

D1 is the single source of truth: identity (`customers`), business documents
(`settings` JSON docs), transactions-in-the-plain-sense (`orders` +
`order_events` append-only), money ledger (`wallet_entries`), loyalty
(`referral_rewards`), support (`support_tickets`/`support_messages`), broadcast
jobs (`announcements`/`announcement_deliveries`), exactly-once scaffolding
(`update_dedupe`, `payment_reminders`, `service_notifications`), short-lived
armed prompts (`admin_actions`), config audit (`settings_audit`), conversation
sessions (`conversation_states`). No external cache/queue; state machine and
sales-stop have zero worker-memory assumptions (every read hits D1; survives
restarts/redeploys by construction).

## 9. External API boundaries

Only two external systems: **Telegram Bot API** (outbound HTTPS to
`api.telegram.org`; only the token in headers; `sendMessage/sendPhoto/sendDocument/
editMessageText/editMessageCaption/answerCallbackQuery/getMe` — `src/telegram/api.ts`)
and the **PasarGuard panel** (4 endpoints, `x-api-key` — [PasarGuard](pasarguard.md)).
Everything else is internal. No third-party analytics, no CDN assets, no webhooks
out; the only inbound endpoint is the Telegram webhook (+ public `/health` that
exposes presence booleans only).

## 10. Source map — feature → implementation files

| Feature | Files |
| --- | --- |
| Webhook auth + ACK policy | `src/routes/webhook.ts` |
| Update pipeline, dedupe, registration, routing | `src/dispatch.ts`, `src/db/dedupe.ts`, `src/db/customers.ts` |
| Conversation state machine + session persistence | `src/state/machine.ts`, `src/db/states.ts` |
| Catalog load + cross-doc fail-closed validation | `src/catalog/catalog.ts`, ladders seeded `0003`/edited `0006`,`0012` |
| Price formula + snapshots | `src/catalog/pricing.ts` |
| Pricing admin surface (edit tokens, bounds, canonical render) | `src/handlers/pricingAdmin.ts`, `src/catalog/pricingDoc.ts`, `src/db/pricing.ts` (CAS + `settings_audit`) |
| Order creation (idempotency, wallet paths, checkout backstop) | `src/orders/checkout.ts`, `src/db/orders.ts`, `src/handlers/purchase.ts` |
| Payment instructions + receipts + admin review queues | `src/catalog/payment.ts`, `src/handlers/payment.ts`, `src/admin.ts`, `src/telegram/format.ts` |
| Wallet ledger + admin money commands | `src/db/wallet.ts`, `src/catalog/wallet.ts`, `src/handlers/wallet.ts` |
| Referral codes/attribution/payouts | `src/db/referrals.ts`, `src/catalog/referral.ts`, `src/lib/referralPayout.ts`, `src/handlers/referrals.ts` |
| Support tickets | `src/db/support.ts`, `src/handlers/support.ts` |
| Announcements broadcast | `src/db/announcements.ts`, `src/handlers/announcements.ts` |
| Renewals (ladder, apply, forward-only expiry booking) | `src/handlers/renewal.ts`, `src/catalog/renewal.ts`, `src/db/orders.ts` (`renew_target_unix`, `claimRenewalTarget`), `src/provision/provision.ts` (extend path) |
| Provisioning orchestrator + panel client | `src/provision/provision.ts`, `src/pasarguard/client.ts`, policy `src/catalog/provisioning.ts` |
| My Services (list/detail, live panel enrich, CTAs) | `src/handlers/services.ts` |
| 8C reminder sweep | `src/handlers/paymentReminders.ts`, `src/db/paymentReminders.ts` |
| Phase 9 notification sweep | `src/handlers/serviceNotifications.ts`, `src/db/serviceNotifications.ts` |
| Sales stop | `src/handlers/salesAdmin.ts`, `src/catalog/sales.ts`, `src/db/sales.ts`, gates `src/handlers/{purchase,renewal}.ts` + backstop `src/orders/checkout.ts` |
| i18n boundary + bundles | `src/telegram/i18n.ts`, `texts.ts`, `texts.en.ts`; persistence `0010` |
| Keyboards + callback vocabulary + reply-keyboard routing | `src/telegram/menu.ts` |
| Connection guide (static registry, stateless) | `src/telegram/guide.ts`, `src/handlers/guide.ts` |
| Input validation/security primitives | `src/lib/validate.ts`, `src/lib/security.ts`, `src/lib/configName.ts` |
| Health endpoint | `src/routes/health.ts` |
| Cron wiring | `src/index.ts:scheduled`, `wrangler.jsonc → triggers.crons` |
| DB migrations | `migrations/0001…0014.sql` |
| Test harness | `tests/helpers.ts` (in-memory `node:sqlite` D1 shim + Telegram fetch stub) + `phase*.test.ts` |

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/architecture.md)
