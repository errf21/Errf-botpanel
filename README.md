# telbotv2 — Telegram VPN Sales Bot

Professional Telegram bot for selling VPN configurations/services.

**Architecture:** Telegram Bot → Cloudflare Worker → Cloudflare D1 → PasarGuard Panel API.
Payment verification is intentionally **manual** (admin approval); everything else is automated where practical.

## Project layout

```
wrangler.jsonc              Worker config: D1 binding, non-secret vars
migrations/0001_init.sql    D1 foundation schema (orders, audit trail, settings)
migrations/0002_phase2.sql  conversation_states + update_dedupe
migrations/0003_phase3.sql  orders.idempotency_key + seeded catalog/pricing docs
migrations/0004_phase4.sql  payment_info seed + admin_actions table
migrations/0005_phase5.sql  provision_attempts/subscription_url + provisioning doc seed
src/index.ts                Fetch router: /health, /telegram/webhook
src/types.ts                Env bindings, state enums, Telegram types, UpdateContext
src/dispatch.ts             Update pipeline: dedupe → register → route to handlers
src/admin.ts                Admin authorization, receipt forwarding, review actions + provisioning trigger
src/routes/health.ts        Liveness + D1 connectivity + binding status
src/routes/webhook.ts       Auth webhook gates → dispatch (always ACKs)
src/telegram/api.ts         Telegram Bot API client (token only in env)
src/telegram/menu.ts        Callback vocabulary + keyboards (incl. admin `adm:`)
src/telegram/texts.ts       All user-facing text (Persian-first), one place
src/handlers/commands.ts    /start /cancel /help /pending /failed (admin)
src/handlers/callbacks.ts   Menu + flow + admin-review/retry buttons (format AND allowlist)
src/handlers/messages.ts    Text → state machine; admin reject-reason interception
src/handlers/payment.ts     Receipt submission, payment instructions, orders/queue views
src/handlers/provisioning.ts Phase 5 admin queue: /failed + `adm:rt` retry taps
src/state/machine.ts        Pure conversation state machine
src/catalog/catalog.ts      Load + validate settings JSON (volumes/durations/devices/pricing)
src/catalog/pricing.ts      Pure integer price engine (rates + breakdown snapshot)
src/catalog/payment.ts      Load + validate payment_info JSON (degrade-safe)
src/catalog/provisioning.ts Load + validate provisioning-policy JSON (degrade-safe)
src/pasarguard/client.ts    PasarGuard REST client: X-Api-Key, timeouts, typed errors
src/provision/provision.ts  THE ONLY provisioning path: claim → pre-check → create → audit
src/db/orders.ts            Orders: atomic create, idempotency, guarded receipt/review/provision transitions
src/db/admin_actions.ts     Short-lived pending admin reject (reason prompt)
src/db/customers.ts         Customers: idempotent upsert, is_admin flag, contact/admin-chat lookup
src/db/{states,dedupe}.ts   Conversation sessions (24h TTL) + webhook replay guard
src/orders/checkout.ts      Draft → priced → durable order (single creation path, replay-safe)
src/handlers/purchase.ts    Buy steps + summary + confirmation (values re-checked vs DB catalog)
src/lib/security.ts         ULID order IDs, constant-time secret comparison
src/lib/validate.ts         Payload guards: callbacks (incl. admin+ULID), media, sanitizers
src/lib/http.ts             Response helpers
tests/                      node --test: machine, validation, price, e2e phases 2–5
.dev.vars.example           Template for local secrets (copy → .dev.vars)
```


## Prerequisites

- Node.js (v20+), npm
- A Cloudflare account (`npx wrangler login`)

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in local secret values
```

### D1 database

```bash
npx wrangler d1 create telbot-db
# paste the returned database_id into wrangler.jsonc (replaces REPLACE_WITH_D1_DATABASE_ID)

npx wrangler d1 migrations apply telbot-db --local    # local dev DB
npx wrangler d1 migrations apply telbot-db --remote   # production (at deploy time)
```

### Secrets — never commit, never hardcode, never log

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PASARGUARD_API_KEY    # Phase 5 (panel admin → API keys)
```

Non-secret configuration (panel URL, admin chat id) lives in `wrangler.jsonc`
as `vars`. **Business data** (volume/duration/device options, prices, payment
information) lives in the D1 `settings` table as JSON documents (schema-versioned).
The 0003 migration seeds placeholder catalog/pricing; changing a rate, a preset,
a minimum, or enabling/disabling/reordering an option is a **D1 edit only** —
never a code change, never a redeploy.

### Catalog & pricing model

Each of `volume_options`, `duration_options`, `device_options`, `pricing` is a
versioned JSON document validated at load time (`src/catalog/catalog.ts`). A
malformed/incompatible document degrades to a friendly "temporarily unavailable"
response; it never crashes or silently invents defaults.

**Price formula** (`src/catalog/pricing.ts`, integer-only — no float money):

```
months = ceil(duration_days / days_per_month)
total  = volume_gb            × gb_rate
       + months               × month_rate
       + max(0, devices − 1)  × device_rate
```

All inputs and rates are validated as safe integers with hard caps, so prices
cannot overflow. The calculated **breakdown including the exact rates used** is
snapshotted into each order, so later catalog edits can never alter a placed
order. Presets and custom values are re-validated against the freshly loaded
catalog on every update — keyboard payload values are never trusted.

## Local development

```bash
npm run typecheck        # tsc --noEmit
npm test                 # node --test (state machine, payload validation, D1+dispatcher e2e)
npm run dev              # wrangler dev  (uses .dev.vars + local D1 copy)

curl http://localhost:8787/health                  # status + checks
printf '{"update_id":1}' | curl -sX POST http://localhost:8787/telegram/webhook \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" -H 'content-type: application/json' -d @-
```

## Endpoints

| Method | Path                | Purpose                                            |
| ------ | ------------------- | -------------------------------------------------- |
| GET    | `/health`           | Liveness, D1 connectivity, binding status          |
| POST   | `/telegram/webhook` | Telegram updates; requires matching secret header  |

The webhook endpoint fails **closed** (503) until `TELEGRAM_WEBHOOK_SECRET` is
configured and rejects requests with a wrong token (401).

## Order safety model

- ULID unique order IDs (sortable, collision-resistant)
- Strict order `state` enum (CHECK constraint in SQLite); drafts start `pending_payment`
- Draft `order_token` → `orders.idempotency_key` with **partial UNIQUE index**:
  the same confirmation can never create two order rows (3 layers: update
  dedupe → session order_id check → DB unique race guard)
- Order creation = `db.batch()` transaction (order row + audit event, atomic)
- `selections` stores an immutable snapshot: chosen options + full price
  breakdown with applied rates + catalog limits — later config changes
  cannot alter placed orders
- `pasarguard_username` / `pasarguard_user_id` are `UNIQUE` → duplicate service creation prevented at DB level
- `order_events` = append-only audit trail of every transition and admin action
- Payment receipt fields isolated from selections; admin verification tracked separately

## Payment & admin review model (Phase 4)

- After confirmation the customer receives payment instructions rendered from
  the D1 `payment_info` settings doc (card/holder/IBAN/instructions — placeholders
  in 0004, edited without redeploy) plus the order's snapshotted amount.
- A receipt is a **photo or document message** (caption = optional payment
  reference); text is politely ignored. Submitted in `WAITING_PAYMENT_RECEIPT`,
  stored on the order (`receipt_file_id`/`payment_reference`), order moves
  `pending_payment → awaiting_review` and the receipt is forwarded to every
  admin (photo/document + approve/reject buttons). A second upload **replaces**
  the receipt while still `awaiting_review` (audited, re-forwarded).
- Admins = env `ADMIN_CHAT_ID` **or** `customers.is_admin = 1` (row added in
  P1). Forwarding targets both. `/pending` re-lists awaiting orders with
  buttons (recovery path).
- Approval/rejection: inline buttons on the forwarded receipt. Reject asks for
  a reason (free text, sanitized, ≤200 chars; a skip button applies a default);
  the pending prompt lives in `admin_actions` with a 15-min TTL. Transitions
  are **single guarded UPDATEs** (`WHERE state='awaiting_review'` + affected-row
  check) so double taps / two admins cannot process an order twice; winners
  audit `payment_approved|payment_rejected` with `actor='admin:<telegram_id>'`.
- Every admin action resets the customer's conversation to IDLE, notifies the
  customer of the outcome (with the rejection reason), and edits the admin
  message to neutralize dead buttons. Verification is **always manual** —
  Phase 5 (PasarGuard) only ever acts on `approved` orders.

## Provisioning model (Phase 5)

- Approval triggers one provisioning attempt: the webhook ACKs immediately and
  provisioning runs on the Worker's `waitUntil` (`pasarguard/client.ts` →
  `provision/provision.ts`).
- One guarded UPDATE claims `approved → provisioning` (admin retry claims
  `failed → provisioning` against a cap) — double taps, replays and parallel
  instances can never run two creates for one order.
- The panel username is deterministic (`provisioning.username_prefix` +
  order id, lower case) and is claimed on the order row **before** any panel
  call (`UNIQUE` guard). Every attempt pre-checks `GET /api/user/by-username/`
  first: a pre-existing service is adopted (e.g. after an ambiguous timeout),
  so the POST is never blindly repeated and duplicates are impossible by
  design. A 409 from create re-reads the winner and adopts it.
- `POST /api/user` payload: `status`, `data_limit` (= volume GB × 10⁹ bytes),
  `expire_duration` (= days × 86400 s), `hwid_limit` (= device count),
  `group_ids` + policy from the versioned `provisioning` settings doc (0005 —
  admin-editable, never code), and `note: telbot:<order-id>`.
- Success → `completed` + `pasarguard_user_id`/`subscription_url` +
  `service_created_at`, audited, and the customer instantly receives the
  panel's subscription link. Failure (network/5xx/rejected) → `failed` +
  capped sanitized reason; the customer is told it is being handled, admins
  get a push with a retry button and `/failed` lists the whole queue.
- **Strict fail-closed no-op**: without `PASARGUARD_API_KEY`/panel URL, or a
  valid+enabled `provisioning` doc, `provisionOrder` performs zero DB or
  network writes and the order simply remains `approved` (Phase 1–4 behavior
  unchanged on every existing path).
- The API key travels only in the `x-api-key` HTTPS header, is never logged and
  never reaches any Telegram text. Two panel wire-format assumptions remain
  (SI 10⁹-byte `data_limit`, `X-Api-Key` acceptance): confirm with **read-only**
  authenticated GETs before the first real production deploy.

## Roadmap

- **Phase 1**: skeleton, config layer, webhook auth, schema ✅
- **Phase 2**: registration, main menu, callbacks, conversation state machine ✅
- **Phase 3**: catalog config layer, integer pricing, buy steps → summary → idempotent order creation ✅
- **Phase 4**: payment receipt upload + admin approval queue (manual verification) ✅
- Phase 5 (this): PasarGuard integration + automatic provisioning (idempotent) ✅
- Phase 6: My Services + status + renewals
- Phase 7: support + referrals + wallet
- Phase 8: bot personality / friendly UX
- Phase 9: security hardening + duplicate prevention + tests
- Phase 10: final Cloudflare deployment + webhook registration

