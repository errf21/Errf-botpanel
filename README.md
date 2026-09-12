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
src/index.ts                Fetch router: /health, /telegram/webhook
src/types.ts                Env bindings, state enums, Telegram types, UpdateContext
src/dispatch.ts             Update pipeline: dedupe → register → route to handlers
src/routes/health.ts        Liveness + D1 connectivity + binding status
src/routes/webhook.ts       Auth webhook gates → dispatch (always ACKs)
src/telegram/api.ts         Telegram Bot API client (token only in env)
src/telegram/menu.ts        Callback vocabulary + main-menu keyboards
src/telegram/texts.ts       All user-facing text (Persian-first), one place
src/handlers/commands.ts    /start /cancel /help
src/handlers/callbacks.ts   Menu + flow buttons (format AND allowlist validated)
src/handlers/messages.ts    Text input → state machine (config-name step today)
src/state/machine.ts        Pure conversation state machine (extensible by Phase 3)
src/catalog/catalog.ts      Load + validate settings JSON (volumes/durations/devices/pricing)
src/catalog/pricing.ts      Pure integer price engine (rates + breakdown snapshot)
src/db/orders.ts            Order repository: atomic insert via db.batch(), idempotency lookup
src/orders/checkout.ts      Draft → priced → durable order (single creation path, replay-safe)
src/handlers/purchase.ts    Buy steps + summary + confirmation (values re-checked vs DB catalog)
src/db/{customers,states,dedupe}.ts   Repositories (idempotent upserts, session TTL)
src/lib/security.ts         ULID order IDs, constant-time secret comparison
src/lib/validate.ts         Payload guards: callback format, ids, config names
src/lib/http.ts             Response helpers
tests/                      node --test: machine logic, payload validation, e2e loop
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
npx wrangler secret put PASARGUARD_API_KEY    # Phase 5
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

## Roadmap

- **Phase 1**: skeleton, config layer, webhook auth, schema ✅
- **Phase 2**: registration, main menu, callbacks, conversation state machine ✅
- **Phase 3 (this)**: catalog config layer, integer pricing, buy steps → summary → idempotent order creation ✅
- Phase 4: payment receipt upload + admin approval queue
- Phase 5: PasarGuard integration + automatic provisioning (idempotent)
- Phase 6: My Services + status + renewals
- Phase 7: support + referrals + wallet
- Phase 8: bot personality / friendly UX
- Phase 9: security hardening + duplicate prevention + tests
- Phase 10: final Cloudflare deployment + webhook registration

