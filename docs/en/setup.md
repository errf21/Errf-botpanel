# Setup & Requirements — English

🇬🇧 English · [🇮🇷 فارسی](../fa/setup.md) · [index](README.md)

Everything needed to go from an empty machine to a verified, running TELBOTV2.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Requirements

### Accounts & services

| Requirement | Why | Notes |
| --- | --- | --- |
| Cloudflare account | Worker + D1 + cron | Free tier is technically usable; this project needs no paid add-on for its code paths. |
| Cloudflare Worker | The whole application | Deployed from `wrangler.jsonc`. |
| Cloudflare D1 (`telbot-db`) | All state + business config | Binding name is `DB`; created with `wrangler d1 create telbot-db`. |
| Telegram bot | The user interface | From @BotFather (`/newbot`, token). |
| Telegram admin chat id(s) | Admin authorization | One numeric id in `ADMIN_CHAT_ID` +/or `customers.is_admin=1` rows. |
| PasarGuard panel | Provisioning | Reachable HTTPS base URL an API key (panel admin UI → API keys). |

### Tooling (per `package.json`, `wrangler.jsonc`, tests)

| Tool | Version | Evidence |
| --- | --- | --- |
| Node.js | **≥ 22.18 or ≥ 23.6** (repo authoring environment ran v23+) | Tests run TypeScript directly with `node --test tests/*.test.ts` and require the built-in `node:sqlite` (`DatabaseSync`) — older Node cannot run the suite. |
| npm | ships with Node | `package-lock.json` present. |
| Wrangler | `^4.0.0` (devDependency, no global install needed) | `package.json → devDependencies`. |
| TypeScript | `^5.6.0` (devDependency) — typecheck only, `noEmit` | `tsconfig.json`, `npm run typecheck`. |

No database server, no build pipeline, no container: the Worker and the in-Worker
D1 are the runtime. There is **no lint script** in this project (see
[Development](development.md)).

## 2. Get the code

```bash
git clone <repo-url> telbotv2
cd telbotv2
npm install
```

## 3. Local development setup

```bash
# 1) secrets for local runs (never committed — .dev.vars is gitignored)
cp .dev.vars.example .dev.vars
#    fill: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
#          PASARGUARD_API_KEY (optional), PAYMENT_CARD_NUMBER

# 2) create a D1 database (you do this once, also used for production)
npx wrangler login
npx wrangler d1 create telbot-db
#    → copy the returned database_id into wrangler.jsonc
#      (replaces "REPLACE_WITH_D1_DATABASE_ID")

# 3) apply all 13 migrations to the LOCAL dev DB
npm run db:migrate:local        # = wrangler d1 migrations apply telbot-db --local

# 4) sanity gates
npm run typecheck
npm test                        # 22 test files, in-memory D1 + fake Telegram

# 5) run locally
npm run dev                     # wrangler dev → http://localhost:8787
curl http://localhost:8787/health
```

`wrangler dev` does **not** fire the 5-minute cron; the reminder/notification
sweeps are exercised in tests by direct invocation (see
[Architecture](architecture.md)).

## 4. Production secrets & vars

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PASARGUARD_API_KEY      # enables provisioning (no-op while unset)
npx wrangler secret put PAYMENT_CARD_NUMBER     # seller card — only source customers see
```

Non-secret vars (`ADMIN_CHAT_ID`, `PASARGUARD_PANEL_URL`) live in
`wrangler.jsonc → vars`. Full reference: [Configuration](configuration.md).

## 5. Migrate + deploy + register webhook

Order matters: **migrate before (or with) deploy**, then register the webhook
only when the Worker + DB are healthy.

```bash
npx wrangler d1 migrations list telbot-db --remote   # confirm pending = 0001..0014
npx wrangler d1 migrations apply telbot-db --remote
npm run deploy                                        # = wrangler deploy
npx wrangler tail                                     # optional: watch logs
```

Telegram webhook (exact command + verification): [Telegram](telegram.md).
Full go-live runbook incl. verification and rollback:
[Deployment](deployment.md).

## 6. Required post-setup D1 edits

Fresh databases get seeded **placeholder** business configs (prices 45000/4500…,
card-holder placeholder text, `group_ids [24,25]`, prefix `pg`). Before taking
real money, edit the D1 settings documents (SQL examples in
[Configuration](configuration.md) or the live
`/pricing` surface — [Pricing](pricing.md)), and set a real `payable`-correct
seller card (secret only). Also seed/repair: `provisioning.enabled`,
`renewal.enabled`, `wallet.enabled`, `referral.enabled` per your intent.

## 7. Production checklist — FROM ZERO → PRODUCTION READY

```
□  Repo cloned, `npm install` clean
□  .dev.vars filled locally (no real values committed; .gitignore covers it)
□  D1 created, database_id pasted into wrangler.jsonc
□  All secrets set in production via `wrangler secret put` (4 secrets)
□  ADMIN_CHAT_ID set to the primary admin's numeric Telegram id
□  PASARGUARD_PANEL_URL is the real HTTPS panel base URL (protocol https, root path)
□  Migrations applied: `wrangler d1 migrations list --remote` shows no pending
□  Settings docs reviewed & placeholders replaced (pricing/payment_info/provisioning)
□  npm run typecheck && npm test  → green
□  `wrangler deploy` succeeds; GET <worker-url>/health returns status=healthy,
   checks.d1=ok, telegram_token/webhook_secret true, pasarguard_key true
□  POST <worker-url>/telegram/webhook without the secret header → 401
□  Webhook registered (setWebhook + secret_token) and getWebhookInfo shows YOUR
   url, empty pending, no last_error
□  Smoke test in Telegram: /start (main menu, Persian by default), menu:buy
   full order → instructions show ONLY the final payable amount and YOUR card
   → receipt → /pending shows it → approve → service link arrives within
   seconds (waitUntil provisioning)
□  /sales state verified (stop → customer notice; start → resume)
□  Real business data confirmed: first live panel call proven via read-only
   GET or the smoke-test order — provisioning verified end-to-end
□  Admin runbook handed over (queues, retries, refunds) → [Admin](admin.md)
```

Next: [Configuration](configuration.md) → [Architecture](architecture.md).

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/setup.md)
