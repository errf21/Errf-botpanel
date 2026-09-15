# TELBOTV2 — Telegram VPN Sales Bot

> A production-grade Telegram bot for selling VPN services, running entirely on
> Cloudflare Workers + D1, with automatic provisioning on a **PasarGuard** panel and
> intentionally **manual** (admin-verified) card payments.

[🇮🇷 **مستندات فارسی**](docs/fa/README.md) · English (default)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## What it does

TELBOTV2 is a self-contained sales office for a VPN operation:

- Customers browse options, place orders, pay by **card**, upload a receipt, and get a
  working subscription link — all inside Telegram, in **Persian or English**.
- The bot prices every order with a live, admin-editable pricing model, provisions the
  service on the PasarGuard panel automatically after payment approval, handles
  renewals, wallets, referrals, a one-time free test (100 MB / 1 day, once EVER per
  user, DB-enforced), support tickets, announcements, usage/expiry notices,
  and a connection guide — with an audit trail behind every money decision.

**Automated:** catalog & order placement flows, pricing, idempotent order creation,
provision (one guarded path), renewals, wallet ledger, referral payouts, reminders and
service notifications, language, safety checks everywhere.
**Manual by design:** payment verification (the admin reviews every uploaded receipt),
funds reconciliation on rejected payments (wallet refund), wallet grants/debits
(`admin /credit` / `admin /debit`), announcements authoring, sales stop/resume, pricing edits (admin-confirmed), panel-service deletion (`/panel_del` — admin-only, explicit confirmation, terminal `panel_deleted` disposition).

## Architecture

```
Telegram ⇄ Cloudflare Worker (this repo) ⇄ Cloudflare D1 ⇄ PasarGuard panel API
             webhook /telegram/webhook      single source      provisioning &
             + /health + 5-min cron         of truth (JSON     live reads
              sweeps                settings docs, orders,
                                    ledgers, audit)
```

Full details: [Architecture](docs/en/architecture.md) · [معماری](docs/fa/architecture.md)

## Feature overview

| Area | Status | Where |
| --- | --- | --- |
| Browse & buy (volume / duration / device presets, custom input where allowed) | ✅ | [Features](docs/en/features.md) |
| Card payment + manual receipt verification by admins | ✅ | [Payment & Wallet](docs/en/payment-wallet.md) |
| PasarGuard provisioning (idempotent create + renewal extend) | ✅ | [PasarGuard](docs/en/pasarguard.md) |
| Integer pricing model, live `/pricing` editing, snapshots, audit | ✅ | [Pricing](docs/en/pricing.md) |
| My Services (live panel status + local snapshot), renewals | ✅ | [Features](docs/en/features.md) |
| Wallet (ledger-based, guarded credit/debit, full/partial order payment) | ✅ | [Payment & Wallet](docs/en/payment-wallet.md) |
| Referrals (first-touch attribution, capped exactly-once payouts) | ✅ | [Payment & Wallet](docs/en/payment-wallet.md) |
| One-time free test (100 MB / 1 day, once EVER per user — `free_test_claims` PK wall, byte-based provisioning, never renewable) | ✅ | [Features](docs/en/features.md) |
| Support tickets + chunked resumable broadcast announcements | ✅ | [Admin](docs/en/admin.md) |
| Payment-review reminders + usage-90%/expiry service notices (cron sweeps) | ✅ | [Architecture](docs/en/architecture.md) |
| Sales stop / resume switch `/sales` (commercial kill switch) | ✅ | [Pricing](docs/en/pricing.md) |
| Admin service delete `/panel_del` (explicit confirm; panel FIRST, then terminal `panel_deleted`; manual panel-side deletes reconciled; history never destroyed) | ✅ | [PasarGuard](docs/en/pasarguard.md) |
| Connection guide (stateless, verified official app links) | ✅ | [Customer guide](docs/en/customer-guide.md) |
| Full Persian + English UI (explicit choice, Persian default) | ✅ | [Localization](docs/en/localization.md) |

## Quick start

```bash
git clone <this-repo-url> && cd telbotv2
npm install
cp .dev.vars.example .dev.vars        # fill with LOCAL dev secrets — never commit
npx wrangler d1 create telbot-db      # paste database_id into wrangler.jsonc
npm run db:migrate:local              # apply migrations 0001→0014 to the local DB
npx wrangler secret put TELEGRAM_BOT_TOKEN        # (and the other 3 secrets)
npm run typecheck && npm test         # must pass before anything else
npm run dev                           # http://localhost:8787/health
```

The complete from-zero → production path is
[setup](docs/en/setup.md) + [deployment](docs/en/deployment.md).

## Configuration in one table

| Name | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | The database `telbot-db` (schema + business config as JSON docs) |
| `TELEGRAM_BOT_TOKEN` | Secret | Bot token from BotFather — send replies only |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token`; webhook fails closed without it |
| `PASARGUARD_API_KEY` | Secret | Panel API key (`x-api-key` header); provisioning a strict no-op while unset |
| `PAYMENT_CARD_NUMBER` | Secret | Seller card — the ONLY runtime source of the card shown to customers |
| `ADMIN_CHAT_ID` | Var (`wrangler.jsonc`) | One numeric Telegram user id of the primary admin |
| `PASARGUARD_PANEL_URL` | Var (`wrangler.jsonc`) | Panel base URL (HTTPS-only, validated) |

All variables, how to obtain them, and every business settings document that lives in
D1 are documented in [Configuration](docs/en/configuration.md) ·
[پیکربندی](docs/fa/configuration.md). **Never commit real values; never log secrets.**

## Repository layout

```
src/                TypeScript Worker (no framework, minimal deps)
├─ index.ts         fetch router + scheduled (cron) entry points
├─ dispatch.ts      update pipeline: dedupe → register → route (always ACK)
├─ admin.ts         admin authorization, review, refund/payout
├─ routes/          /health  /telegram/webhook
├─ handlers/        all Telegram flows (customer + admin surfaces)
├─ state/machine.ts pure conversation state machine
├─ catalog/         config-doc loaders + price/validation engines (fail-closed)
├─ db/              guarded SQL (D1) per domain — claims, CAS, ledgers, audits
├─ orders/checkout  the single path from priced draft → durable order
├─ pasarguard/      typed REST client (X-Api-Key, timeouts, error kinds)
├─ provision/       THE provisioning orchestrator (create + extend, idempotent)
└─ telegram/        api client, keyboards, en/fa text bundles, i18n boundary
migrations/         0001→0014 — strict linear order, additive/seeded (enum
                    changes shipped as CHECK-rebuild migrations)
tests/              node --test: unit + e2e against in-memory SQLite D1 shim
docs/en/ docs/fa/   full bilingual documentation (this site)
wrangler.jsonc      Worker config: binding, vars, cron, migrations dir
```

## Documentation

| # | English (English) | فارسی (Persian) |
| --- | --- | --- |
| 1 | [Setup & requirements](docs/en/setup.md) | [راه‌اندازی و پیش‌نیازها](docs/fa/setup.md) |
| 2 | [Configuration](docs/en/configuration.md) | [پیکربندی](docs/fa/configuration.md) |
| 3 | [Architecture & source map](docs/en/architecture.md) | [معماری و نقشهٔ کد](docs/fa/architecture.md) |
| 4 | [Database & migrations](docs/en/database.md) | [پایگاه داده و مهاجرت‌ها](docs/fa/database.md) |
| 5 | [Telegram setup](docs/en/telegram.md) | [راه‌اندازی تلگرام](docs/fa/telegram.md) |
| 6 | [PasarGuard integration](docs/en/pasarguard.md) | [یکپارچه‌سازی PasarGuard](docs/fa/pasarguard.md) |
| 7 | [Features (implemented)](docs/en/features.md) | [امکانات پیاده‌سازی‌شده](docs/fa/features.md) |
| 8 | [Pricing model & sales stop](docs/en/pricing.md) | [مدل قیمت‌گذاری و توقف فروش](docs/fa/pricing.md) |
| 9 | [Payment, wallet & referrals](docs/en/payment-wallet.md) | [پرداخت، کیف پول و دعوت](docs/fa/payment-wallet.md) |
| 10 | [Admin operations guide](docs/en/admin.md) | [راهنمای عملیات ادمین](docs/fa/admin.md) |
| 11 | [Customer guide](docs/en/customer-guide.md) | [راهنمای مشتری](docs/fa/customer-guide.md) |
| 12 | [Localization](docs/en/localization.md) | [زبان و بومی‌سازی](docs/fa/localization.md) |
| 13 | [Security model](docs/en/security.md) | [مدل امنیتی](docs/fa/security.md) |
| 14 | [Development](docs/en/development.md) | [توسعه](docs/fa/development.md) |
| 15 | [Deployment & updates](docs/en/deployment.md) | [استقرار و به‌روزرسانی](docs/fa/deployment.md) |
| 16 | [Troubleshooting](docs/en/troubleshooting.md) | [عیب‌یابی](docs/fa/troubleshooting.md) |
| 17 | [Maintenance](docs/en/maintenance.md) | [نگهداری](docs/fa/maintenance.md) |

## Production status

The codebase implements Phases 1–13 (each with green tests). **The Worker itself has
not been proven deployed in this repository's evidence**: `wrangler.jsonc` still ships
with `database_id = REPLACE_WITH_D1_DATABASE_ID`, and migrations/webhook registration
are operator actions done outside the repo. Follow
[Deployment](docs/en/deployment.md) / [استقرار](docs/fa/deployment.md) and the
**Production checklist** there to go live or to audit a live instance — including
checking which of the 13 migrations are actually applied.

## Security notes

- Secrets are only ever provided via `wrangler secret put` / `.dev.vars`; the `.dev.vars`
  file is git-ignored. No token, card number, or API key may ever enter commits, logs, or
  Telegram messages (enforced by the code paths themselves).
- The webhook is fail-closed until `TELEGRAM_WEBHOOK_SECRET` is set and validates the
  secret (constant-time) before touching anything.
- Panel keys travel only in the `x-api-key` HTTPS header.
- All money transitions are single guarded SQL updates plus append-only ledger/audit rows —
  double taps, replays, and concurrent admins converge on exactly one winner.

## License

No license file is present in this repository yet (as of this documentation pass). All
rights are reserved by the author until a `LICENSE` is added. © [Espierz](https://t.me/Espierz)

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** ·
Telegram / تلگرام: [@Espierz](https://t.me/Espierz)
— [🇮🇷 فارسی](docs/fa/README.md)
