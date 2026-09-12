# telbotv2 — Telegram VPN Sales Bot

Professional Telegram bot for selling VPN configurations/services.

**Architecture:** Telegram Bot → Cloudflare Worker → Cloudflare D1 → PasarGuard Panel API.
Payment verification is intentionally **manual** (admin approval); everything else is automated where practical.

## Project layout

```
wrangler.jsonc              Worker config: D1 binding, non-secret vars
migrations/0001_init.sql    D1 foundation schema (orders, audit trail, settings)
src/index.ts                Fetch router: /health, /telegram/webhook
src/types.ts                Env bindings, OrderState enum, Telegram types
src/routes/health.ts        Liveness + D1 connectivity + binding status
src/routes/webhook.ts       Authenticated Telegram webhook entry (ack only in Phase 1)
src/lib/security.ts         ULID order IDs, constant-time secret comparison
src/lib/http.ts             Response helpers
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
information) lives in the D1 `settings` table as JSON — changing the catalog or
prices never requires rewriting bot logic.

## Local development

```bash
npm run typecheck        # tsc --noEmit
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

## Order safety model (foundation)

- ULID unique order IDs (sortable, collision-resistant)
- Strict order `state` enum (CHECK constraint in SQLite)
- D1 `batch()` for transaction-safe multi-statement updates (from Phase 3)
- `pasarguard_username` / `pasarguard_user_id` are `UNIQUE` → duplicate service creation prevented at DB level
- `order_events` = append-only audit trail of every transition and admin action
- Payment receipt fields isolated from selections; admin verification tracked separately

## Roadmap

- **Phase 1 (this)**: skeleton, config layer, webhook auth, schema ✅
- Phase 2: users + menu + conversational state machine
- Phase 3: product options + pricing engine + order creation
- Phase 4: payment receipt upload + admin approval queue
- Phase 5: PasarGuard integration + automatic provisioning (idempotent)
- Phase 6: My Services + status + renewals
- Phase 7: support + referrals + wallet
- Phase 8: bot personality / friendly UX
- Phase 9: security hardening + duplicate prevention + tests
- Phase 10: final Cloudflare deployment + webhook registration
