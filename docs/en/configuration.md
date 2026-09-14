# Configuration — English

🇬🇧 English · [🇮🇷 فارسی](../fa/configuration.md) · [index](README.md)

Two separate configuration systems exist:

1. **Worker configuration** — bindings, secrets and `vars` (Cloudflare/wrangler).
2. **Business configuration** — versioned JSON **settings documents stored in D1**
   (catalog, pricing, payment, provisioning, policies, sales switch).

Rule of thumb from the codebase design: *business data is a D1 edit, never a code
change or a redeploy*.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Worker bindings, secrets & vars

Confirmed against the `Env` interface (`src/types.ts:7-21`) and every `env.X` read
in `src/`.

### Secrets — set with `wrangler secret put NAME` locally in `.dev.vars`

| Name | Required | Purpose | Missing → behavior |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Outbound Bot API calls (`src/telegram/api.ts`, `dispatch.ts:59`). | Health shows `telegram_token:false`; sends fail. |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Validated on every webhook POST via header `X-Telegram-Bot-Api-Secret-Token`. | **Webhook fails closed: HTTP 503** (`src/routes/webhook.ts:21-24`). Never processes updates. |
| `PASARGUARD_API_KEY` | For provisioning only | Sent as HTTP header `x-api-key` (never logged/never in Telegram text). | Provisioning is a **strict no-op**: approvals park orders in `approved`; zero panel writes (`src/provision/provision.ts`, `src/pasarguard/client.ts:142`). |
| `PAYMENT_CARD_NUMBER` | For payments only | The **only** source of the seller card shown in payment instructions (`src/catalog/payment.ts:48`). | Payment instructions fail closed → customer sees "unavailable, contact support"; event `payment_card_secret_unconfigured` (value never logged). |

> **Never put any secret in code, `wrangler.jsonc`, migrations, README, tests, or
> Git.** `.dev.vars` is git-ignored. The seeded `payment_info.card_number`
> placeholder in `0004` is **inert at runtime** — the loader ignores it by design.

### Non-secret vars — `wrangler.jsonc → vars`

| Name | Example/placeholder | Purpose |
| --- | --- | --- |
| `ADMIN_CHAT_ID` | `""` (set your numeric Telegram id) | Primary admin. Code trims it; a positive integer string that `=== String(actorId)` grants admin (`src/admin.ts:33-34`). It is **one id**, not a list. |
| `PASARGUARD_PANEL_URL` | `https://<panel-host>` | Panel base URL. Validated **HTTPS, origin only** (root path, no embedded credentials/extra path) or provisioning fails closed `panel_url_rejected` (`src/pasarguard/client.ts:138-163`). |

### Binding

| Binding | Kind | Value |
| --- | --- | --- |
| `DB` | D1 database | `telbot-db` — paste a real `database_id` into `wrangler.jsonc` after `wrangler d1 create telbot-db` (ships with `REPLACE_WITH_D1_DATABASE_ID`). |

## 2. Business settings documents (D1 `settings` table)

The `settings` table holds JSON docs (`key TEXT PK`, `value` with a `json_valid`
CHECK, `updated_at`, `updated_by` — `migrations/0001_init.sql`). Each loader
validates the schema/version at read time; a malformed doc **fails closed** to a
friendly "temporarily unavailable" (catalog/pricing) or degrades to disabled
(policy switches) — it never crashes or invents defaults.

| `key` | Schema | Loader | Fields | Role |
| --- | --- | --- | --- | --- |
| `volume_options` | 1 | `src/catalog/catalog.ts` | `min_gb,max_gb,allow_custom,presets[{gb,enabled}]` | Volume ladder. |
| `duration_options` | 1 | `src/catalog/catalog.ts` | `min_days,max_days,allow_custom,presets[{days,enabled}]` | Duration ladder (months-only: 30/60/90). |
| `device_options` | 1 (written by `0012`) | `src/catalog/catalog.ts` | `min_count,max_count,allow_custom,presets[{count,enabled}]` | Device/user limit ladder {1,2,3}, custom OFF. |
| `pricing` | **2** (written by `0011`) | `catalog.ts` + `pricingDoc.ts` | `currency,days_per_month,base_product{gb,users,months,price},price_per_gb,duration_prices{},user_prices{}` | The whole price engine. See [Pricing](pricing.md). |
| `payment_info` | 1 | `src/catalog/payment.ts` | `schema,holder,card_number(ignored),iban,instructions` | Payment instructions (card number comes from the **secret**, not here). |
| `provisioning` | 1 | `src/catalog/provisioning.ts` | `enabled,group_ids[],username_prefix,max_attempts,default_status` | THE master switch over all panel writes. See [PasarGuard](pasarguard.md). |
| `renewal` | 1 | `src/catalog/renewal.ts` | `enabled,near_expiry_days` | Renewal kill switch + "soon" badge threshold. |
| `wallet` | 1 | `src/catalog/wallet.ts` | `enabled,max_credit_irt,max_debit_irt` | Wallet kill switch + per-op caps. |
| `referral` | 1 | `src/catalog/referral.ts` | `enabled,reward_percent,max_rewards_per_referrer` | Referral kill switch + reward% + lifetime cap per referrer. |
| `sales` | 1 (`0013`) | `src/catalog/sales.ts` | `stopped:boolean` | **Fail-open** commercial stop switch. See [Pricing](pricing.md). |
| `business_settings` | 1 | *(none reads it)* | `{"schema":1}` | Dormant/reserved placeholder — **no code reads it**. |

### Editing settings documents

Preferred safe paths:

- **Pricing numbers** → live admin flow `/pricing` (armed → typed → staged →
  confirmed → CAS + `settings_audit`), never raw SQL — [Pricing](pricing.md).
- **Sales switch** → `/sales` buttons → [Pricing](pricing.md).
- **Other docs** (ladders, payment instructions text, provisioning policy,
  policies) → a **single guarded `UPDATE`** through D1. Wrap so you never clobber
  concurrent edits and preserve `json_valid`:

```bash
# Inspect first
npx wrangler d1 execute telbot-db --remote \
  --command "SELECT key, value, updated_by, updated_at FROM settings WHERE key='provisioning';"

# Edit one doc (replace the JSON with your validated document; keep schema field)
npx wrangler d1 execute telbot-db --remote --command \
  "UPDATE settings SET value='{\"schema\":1,\"enabled\":true,\"group_ids\":[24,25],\"username_prefix\":\"pg\",\"max_attempts\":3,\"default_status\":\"active\"}', updated_by='admin:<id>', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='provisioning';"
```

> Do **not** edit the sales or pricing docs by hand in production — those have
> purpose-built CAS + audit paths; a raw edit can create a hash token mismatch
> that only `/pricing` `/sales` self-heal resolves. Raw edits are for the ladder
> and policy docs above with no dedicated UI.

## 3. Seeds are placeholders — verify before going live

Seeded by migrations (`updated_by` shows `migration:00xx` until an admin edits):

- `0011` pricing (`updated_by='migration:0011'`): `base_product.price=45000`,
  `price_per_gb=4500`, `duration_prices {2:80000,3:110000}`, `user_prices`
  1..10. A later `/pricing` edit replaces these and stamps `admin:<id>`.
- `0004` payment_info: holder `«card holder (placeholder)»`, card `6037997100000000`
  (**inert** — real card secret takes over), `iban:null`.
- `0005` provisioning: `group_ids:[24,25]`, `username_prefix:"pg"` — confirm these
  match the real panel groups before first live provisioning.

## 4. Where does NOT belong in config

Money never uses floats; **all amounts are integer IRT (Toman)** stored in `orders.amount`,
`customers.balance_irt`, `wallet_entries.delta_irt`. The bot does not read any
`.env`/dotenv file at runtime in production — only Cloudflare bindings/vars/secrets.
There is **no** `PAYMENT_PROVIDER_TOKEN`, gateway key, or webhook callback URL for
a bank: payment verification is manual by design.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/configuration.md)
