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
migrations/0006_phase6.sql  orders.kind/service_expires_at + renewal states & docs
migrations/0007_phase7.sql  wallet ledger + referrals + support tickets + announcements
migrations/0008_phase8c.sql payment_reminders claim table (+safe backfill)
src/index.ts                Fetch router: /health, /telegram/webhook + 5-min cron (scheduled)
src/types.ts                Env bindings, state enums, Telegram types, UpdateContext
src/dispatch.ts             Update pipeline: dedupe → register (first-start referral probe) → route
src/admin.ts                Admin authorization, receipt forwarding, review + wallet refund + referral payout
src/routes/health.ts        Liveness + D1 connectivity + binding status
src/routes/webhook.ts       Auth webhook gates → dispatch (always ACKs)
src/telegram/api.ts         Telegram Bot API client (token only in env; opt-in HTML parse_mode)
src/telegram/format.ts      Phase 8C: minimal Telegram HTML escape/inline-code helper (copy-friendly values)
src/telegram/menu.ts        Callback vocabulary + keyboards (incl. admin `adm:`, service `svc:`, ticket `tsk:`, announce `ann:`)
src/telegram/texts.ts       All user-facing text (Persian-first), one place
src/handlers/commands.ts    /start /cancel /help /pending /failed /tickets /announce /announcements /credit /debit
src/handlers/callbacks.ts   Menu + flow + service + wallet-pay + ticket/announce + admin-review buttons
src/handlers/messages.ts    Text → state machine; admin intercepts (reject reason, ticket reply, wallet ops)
src/handlers/payment.ts     Receipt submission, payment instructions, orders/queue views
src/handlers/provisioning.ts Phase 5 admin queue: /failed + `adm:rt` retry taps
src/handlers/services.ts    Phase 6 My Services: list + detail (+live panel status)
src/handlers/renewal.ts     Phase 6 renewal ladder + Phase 7 wallet payment for renewals
src/handlers/wallet.ts      Phase 7 wallet view, admin grant/debit (arm→amount→guarded apply)
src/handlers/referrals.ts   Phase 7 invite screen, first-touch capture, payout notices
src/handlers/support.ts     Phase 7 tickets: open/follow-up/queue/reply/close (admin relay)
src/handlers/announcements.ts Phase 7 broadcast: draft → confirm → chunked resumable fan-out
src/handlers/paymentReminders.ts Phase 8C cron sweep: claimed 15/30/45 nudges + one admin digest/run
src/state/machine.ts        Pure conversation state machine (buy + renewal + support + announce ladders)
src/catalog/catalog.ts      Load + validate settings JSON (volumes/durations/devices/pricing)
src/catalog/pricing.ts      Pure integer price engine (rates + breakdown snapshot)
src/catalog/payment.ts      Load + validate payment_info JSON (degrade-safe)
src/catalog/provisioning.ts Load + validate provisioning-policy JSON (degrade-safe)
src/catalog/renewal.ts      Load + validate renewal-policy JSON (kill switch, degrade-safe)
src/catalog/wallet.ts       Load + validate wallet-policy JSON (kill switch + caps, degrade-safe)
src/catalog/referral.ts     Load + validate referral-policy JSON (kill switch + reward/cap, degrade-safe)
src/pasarguard/client.ts    PasarGuard REST client: X-Api-Key, timeouts, typed errors (GET/POST/PUT)
src/provision/provision.ts  THE ONLY provisioning path: purchase-create + renewal-extend, audit
src/db/orders.ts            Orders: atomic create (incl. born-approved wallet orders), guarded receipt/review/provision/renewal + same-batch reject refund
src/db/wallet.ts            Wallet ledger: guarded credit/debit, exactly-once order payment/refund, re-point by id
src/db/referrals.ts         Referral codes, first-touch attribution, exactly-once capped payout (PK guard)
src/db/support.ts           Support tickets: one live per customer (UNIQUE), append-only messages
src/db/announcements.ts     Broadcast jobs: seed-once deliveries, chunk claim/book/settle, stuck sweep
src/db/admin_actions.ts     Short-lived armed admin prompts (reject / ticket reply / grant / debit)
src/db/paymentReminders.ts  Phase 8C: one-anchor reminder schedule per order + single-statement stage claims
src/db/customers.ts         Customers: idempotent upsert, is_admin flag, first-ever probe, admin-chat lookup
src/db/{states,dedupe}.ts   Conversation sessions (24h TTL) + webhook replay guard
src/orders/checkout.ts      Draft → priced → durable order: purchase + renewal + wallet plans (full/partial)
src/handlers/purchase.ts    Buy steps + summary (+wallet buttons) + idempotent confirm & auto-approve
src/lib/security.ts         ULID order IDs, constant-time secret comparison
src/lib/validate.ts         Payload guards: callbacks (admin+service+ticket+announce+ULID), media, sanitizers
src/lib/referralPayout.ts   Shared post-approval referral payout (manual + wallet auto-pay paths)
src/lib/http.ts             Response helpers
tests/                      node --test: machine, validation, price, e2e phases 2–8C
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
npx wrangler secret put PAYMENT_CARD_NUMBER   # Phase 8C: seller card — the ONLY card source
```

**Deploy checklist (Phase 8C):** payment instructions fail **closed** without
`PAYMENT_CARD_NUMBER` (customers get the "not available — contact support"
notice and the event log shows `payment_card_secret_unconfigured` — the value
is never logged). The `card_number` field left over inside the `payment_info`
settings doc is inert at runtime; admins may delete it from the document at
leisure (the 0004 seed placeholder must simply never be relied upon).

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
  never reaches any Telegram text. The panel wire formats were re-confirmed in
  Phase 6 directly against the dashboard's own bundles (`/statics/api-*.js`,
  its user-edit dialog and the `+1m/+2m/+3m` quick buttons): SI `data_limit`
  bytes, absolute unix-second `expire`, `X-Api-Key` auth. Final live proof
  still comes from **read-only** authenticated GETs before the first real
  production deploy.

## Services & renewals model (Phase 6)

- A **service IS a completed purchase order** — no separate table. The order
  gains `kind` (`purchase|renewal`), and services carry `renew_target_unix` /
  `service_expires_at` for exact renewal bookkeeping.
- **My Services** (`menu:services`) lists the customer's completed purchases
  from D1 with a local-computed status (🟢 active / ⏳ near / ‼️ expired).
  A service **detail** optionally enriches with a live panel read
  (`GET by-username`: panel status, absolute expire, used/total traffic) and
  **degrades safely to the D1 snapshot when the panel key/URL is missing or
  the call fails** — an unconfigured panel changes no existing Phase 1–5 path.
- **Renewal is duration-only** (the Phase-6 decision): the ladder asks for 1/2/3
  months (presets, **never custom text**) → summary → confirm → a durable
  `kind='renewal'` order priced `ceil(days/days_per_month) × month_rate`
  (integer, rate-snapshotted like a purchase) that reuses the SAME
  receipt + manual admin-review pipeline. `step:back` steps out of the ladder.
- Renewals are **always allowed** (`renewal.near_expiry_days` only lights up
  the "soon" badge). An **expired** service renews from `now`, not from its
  past expiry — `target = max(now, live/local expire) + days`.
- The renewal `svc:` callbacks embed a full 28-char order id, so they get a
  strict allowlisted pattern (`svc:(det|ref|rnw):<28>`) parsed by
  `parseServiceCallback`; every action re-checks **ownership in the WHERE
  clause** (`customer_id`) server-side — a forged or cross-user id is a
  neutral toast with zero data leak.
- Applying an approved renewal (also via `waitUntil`): one guarded claim
  `approved→provisioning` → resolve the owned **service row** → read current
  expire → claim an ABSOLUTE `renew_target_unix` on the renewal row **before**
  any panel write → if the panel already shows `>= target` ADOPT it (no PUT),
  else `PUT by-username {expire: target}` → verify `>= target` → mark the
  renewal `completed` + book the service's local `service_expires_at`
  **forward-only** (a late/parallel bookkeeping can never shorten it) +
  `service_extended` audit on the service row. Failure → `failed` + retryable
  through `/failed` exactly like a purchase; retries **converge on the already
  claimed target** so an ambiguous write can never stack a double extension.
  It never touches `pasarguard_user_id`/`subscription_url` (they are the
  service's UNIQUE identity).
- The renewal policy lives in a versioned `renewal` settings doc (0006):
  `enabled` is a kill switch that makes the apply step + UI degrade to "not
  available right now" with **strict fail-closed zero DB/network writes** on a
  missing/malformed doc; the single `provisioning.enabled` flag remains the
  one master switch over ALL panel writes (creates AND extensions).

## Payment review reminders (Phase 8C)

- **Trigger:** Cloudflare **Cron Triggers** (`wrangler.jsonc → triggers.crons =
  ["*/5 * * * *"]` → the Worker's `scheduled` handler). The only wall-clock
  mechanism that fires with zero traffic; DO alarms were considered and
  rejected as overkill. `wrangler dev` does not fire crons — tests drive the
  sweep directly with an explicit `now`.
- **Ladder:** anchored at the FIRST receipt submission, stages fire at
  ≥15/≥30/≥45 elapsed minutes — three distinct customer nudges MAX, never
  early (cron granularity only delays ≤5 min), catch-up runs send only the
  TOPMOST due stage (no burst), and nothing is ever sent afterwards: 3 and
  done.
- **Exactly-once mechanics (claim-first, at-most-once):** one
  `payment_reminders` row per order (PK order_id, `INSERT OR IGNORE` —
  a replacement receipt provably cannot add or re-anchor a schedule); each
  stage is claimed by a SINGLE guarded UPDATE whose equality check on
  `reminded_stage` and fused `state='awaiting_review'` subquery make
  overlapping runs, replays and concurrent approvals converge on one winner.
  A crash after a won claim loses that one nudge — the deliberate tradeoff
  (duplicates are worse than a lost nudge).
- **Admin UX:** one consolidated digest per sweep run per admin chat, reusing
  the existing `/pending` queue keyboard (`adm:ok|adm:no`) — approvals from a
  digest go through the unchanged review path; no new callbacks, auth, or
  keyboards.
- **Seller card is a SECRET now:** `PAYMENT_CARD_NUMBER` env is the ONLY card
  source (missing/invalid → the existing fail-closed `paymentInfoUnavailable`
  notice; the settings-doc `card_number` key is ignored). Card/IBAN/
  subscription URLs render as Telegram inline code (tap-to-copy) with a
  one-time «کپی» hint — HTML `parse_mode` is opt-in for exactly those
  bubbles, every dynamic string in them passes through
  `src/telegram/format.ts`, and everything else stays plain text.
- Renewal receipts ride the SAME `submitOrderReceipt` path and are therefore
  covered identically; orders never entering `awaiting_review` (full-wallet,
  abandoned checkouts) have no anchor by construction → unschedulable.

## Roadmap

- **Phase 1**: skeleton, config layer, webhook auth, schema ✅
- **Phase 2**: registration, main menu, callbacks, conversation state machine ✅
- **Phase 3**: catalog config layer, integer pricing, buy steps → summary → idempotent order creation ✅
- **Phase 4**: payment receipt upload + admin approval queue (manual verification) ✅
- **Phase 5**: PasarGuard integration + automatic provisioning (idempotent) ✅
- **Phase 6**: My Services + live/snapshot status + months-only renewals ✅
- **Phase 7**: support + referrals + wallet ✅
- **Phase 8**: bot personality / friendly UX ✅
  - 8A reply keyboard ✅ · 8B persona copy ✅ · 8C payment UX + review reminders ✅
- Phase 9: security hardening + duplicate prevention + tests
- Phase 10: final Cloudflare deployment + webhook registration

