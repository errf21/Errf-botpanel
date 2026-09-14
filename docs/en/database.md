# Database & Migrations — English

🇬🇧 English · [🇮🇷 فارسی](../fa/database.md) · [index](README.md)

Database: **Cloudflare D1** (`telbot-db`, SQLite-compatible), bound as `DB`.
Migrations: `migrations/` (configured via `"migrations_dir": "migrations"` in
`wrangler.jsonc`), applied strictly in filename order `0001 → 0013`.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Migration table (exact order and purpose)

| Order | File | Purpose | Notes |
| --- | --- | --- | --- |
| 1 | `0001_init.sql` | Foundation: `customers`, `orders`, `order_events`, `settings` | Seeds 6 empty settings containers via `INSERT OR IGNORE`; order `state` CHECK enum; UNIQUE panel username/id guards; `selections` json_valid + `amount ≥ 0` CHECKs. |
| 2 | `0002_phase2.sql` | `conversation_states` (8-state CHECK) + `update_dedupe` | Session persistence + webhook replay guard. |
| 3 | `0003_phase3.sql` | `orders.idempotency_key` + partial UNIQUE index | Seeds catalog + **linear-rate placeholder pricing** (schema 1) + ladder docs `{10..500}`, `{30..365}`, `{1,3,5}`. |
| 4 | `0004_phase4.sql` | `admin_actions` (reject) + `payment_info` seed | Card/holder/instructions placeholders (Persian placeholder text). |
| 5 | `0005_phase5.sql` | `orders`: `provision_attempts`, `subscription_url` + `provisioning` doc seed | `group_ids:[24,25]`, prefix `pg`, max 3 attempts, status active. |
| 6 | `0006_phase6.sql` | `orders`: `kind`,`renews_order_id`,`service_expires_at`,`renew_target_unix` + indexes; `conversation_states` rebuild (+2 renewal states); `renewal` doc seed; **duration doc rewritten** to months-only {30,60,90}, custom OFF | CHECK-list rebuilds are the SQLite "create copy → drop → rename" pattern — **non-idempotent, run exactly once, in order**. |
| 7 | `0007_phase7.sql` | Wallet + referral + support + announcements: `balance_irt`/`referred_by`/`referral_code` (partial UNIQUE) on customers; `wallet_entries` (+ partial UNIQUE `idx_wallet_payment_once`), `referral_rewards` (PK = referee), `support_tickets` (+ one-live UNIQUE), `support_messages`, `announcements`, `announcement_deliveries` (composite PK); `conversation_states` rebuild (+3 states, final 13); `admin_actions` rebuild (nullable order, 4 actions, `target_id`); `wallet`+`referral` doc seeds | All money integer IRT. |
| 8 | `0008_phase8c.sql` | `payment_reminders` (PK order_id, stage 0..3) + **safe backfill** | Existing `awaiting_review` orders anchor correctly without nudge-bursts; re-runnable via `INSERT OR IGNORE`. |
| 9 | `0009_phase9.sql` | `service_notifications` (PK `(order_id,kind)`, attempts ≤64) + **suppression backfill** | Pre-marks `expiring/sent` for services already ≤3 days out — never ambushes existing customers on release day; re-runnable. |
| 10 | `0010_phase10.sql` | `customers.language` CHECK `('fa','en')` nullable | **No backfill** — NULL means Persian by design; zero behavior change for existing users. |
| 11 | `0011_pricing_model.sql` | `admin_actions` rebuild (+`pricing` action, 5 total); **`settings_audit`** table (full json_valid before/after docs); `pricing` doc → **schema 2** (exact-entries model) | Header documents that an earlier draft `0011_pricing_admin.sql` was **never applied** and was deleted — this is the real 0011. |
| 12 | `0012_device_limit.sql` | `device_options` doc → {1,2,3}, custom OFF, max 3 | Pricing doc untouched; `user_prices` 4..10 become unreachable compat entries (still valid coverage). |
| 13 | `0013_sales_switch.sql` | `sales` doc `{"schema":1,"stopped":false}` + provenance-only backfill | The commercial stop switch. |

### Ordering rules the code depends on

- Docs updated via `UPDATE ... WHERE key=...` (0003,0004,0006,0011,0012) **require**
  the 0001 container rows to exist — another reason never to skip/rewrite history.
- The twice-rebuilt CHECK tables mean 0006/0007/0011 must run exactly in order.
- Later seeds (`INSERT OR IGNORE`: provisioning, renewal, wallet, referral, sales)
  never clobber operator edits; `0013` even stamps `updated_by` **only when NULL**.

## 2. Schema overview (final state after 0013)

### `customers`
| Column | Constraints | Purpose |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | internal id |
| `telegram_user_id` | **UNIQUE NOT NULL** (TEXT) | external identity |
| `telegram_username`,`first_name`,`last_name`,`language_code` | free text | profile (refreshed by upsert; `language_code` display-only) |
| `is_admin` | DEFAULT 0, CHECK (0,1) | DB-side admin flag (grant: `UPDATE customers SET is_admin=1 WHERE telegram_user_id='<id>'`) |
| `created_at`,`updated_at` | ISO default | |
| `balance_irt` | DEFAULT 0 CHECK ≥0 (0007) | wallet balance — always integer Toman |
| `referred_by` | INTEGER (no FK) | first-touch referrer |
| `referral_code` | partial UNIQUE WHERE NOT NULL | 12-char Crockford base32 code (minted on demand) |
| `language` | CHECK IN ('fa','en') NULLABLE (0010) | **explicit** UI language choice; NULL = Persian |

### `orders` (the service/order record — "a service IS a completed purchase order")
`id` TEXT PK (**ULID 28**, Crockford base32 = 12 time + 16 random);
`customer_id` → customers; `state` CHECK 8 (`pending_payment`,`awaiting_review`,
`approved`,`provisioning`,`completed`,`rejected`,`failed`,`cancelled`);
`selections` NOT NULL json_valid — **immutable snapshot**: chosen options,
`config_name`, full price breakdown incl. applied inputs, catalog limits,
optional `{mode, credit_irt}` wallet block (schema-1 snapshot, schema-2 price
breakdown); `amount` ≥0 INTEGER, `currency` DEFAULT 'IRR' (runtime rows carry the
snapshot's `IRT`); `receipt_file_id`,`payment_reference`,`verified_by`
(`admin:<id>` | `'wallet'`),`verified_at`; `pasarguard_username` **UNIQUE**,
`pasarguard_user_id` **UNIQUE**; `service_created_at`,`failure_reason`;
`idempotency_key` + partial UNIQUE (0003); `provision_attempts`,`subscription_url`
(0005); `kind` CHECK ('purchase','renewal'), `renews_order_id` (soft, indexed),
`service_expires_at` (forward-only local expiry), `renew_target_unix` (absolute
claimed extension target) (0006). Indexes: customer, state, renews.

### Supporting tables
| Table | PK / guards | Purpose |
| --- | --- | --- |
| `order_events` | autoincrement; FK cascade | Append-only audit: actor (`customer` \| `admin:<id>` \| `system`), action, from/to state, JSON data. |
| `settings` | `key` PK; `value` json_valid | Business documents — [Configuration](configuration.md). |
| `settings_audit` | autoincrement | Append-only config audit (`0011`): key, actor, action (`base`,`gb`,`d<m>`,`u<n>`,`stop`,`start`), **full old_value + full new_value JSON**, indexed by (key, created_at). |
| `conversation_states` | PK customer_id, FK cascade | 13-state CHECK session + JSON draft + 24h expiry. |
| `update_dedupe` | PK update_id | Webhook replay guard. |
| `admin_actions` | PK admin_user_id | One armed free-text admin prompt at a time (`reject`,`support_reply`,`wallet_grant`,`wallet_debit`,`pricing`), `order_id` NULLable, `target_id`, 15-min TTL (`ADMIN_ACTION_TTL_MS`). |
| `wallet_entries` | ULID PK; **partial UNIQUE order_id WHERE kind='order_payment'** | Append-only ledger: `delta_irt ≠ 0`, kinds CHECK 5, `balance_after ≥ 0`, actor. Balance moves only via paired guarded-UPDATE+INSERT. |
| `referral_rewards` | **PK referred_customer_id** | Exactly one payout ever per referee (PK = concurrency guard). |
| `support_tickets` / `support_messages` | one-live ticket partial UNIQUE (`open|answered`); ticket FK cascade | Support; messages `sender`/`body`/`file_id`+`file_kind` CHECK/`delivered`. |
| `announcements` / `announcement_deliveries` | delivery **composite PK (announcement_id, customer_id)** | Broadcast jobs; statuses `pending→sending→sent|failed|skipped`, resumable. |
| `payment_reminders` | PK order_id | 8C ladder: `reminded_stage` 0..3 claimed by single guarded UPDATE with `awaiting_review` fused subquery. |
| `service_notifications` | PK (order_id, kind) | Phase 9 once-per-service promise (`usage90`,`expiring`), lease claim (`sending`, stale 30 min), attempts ≤64 bound. |

## 3. Safe migration procedure

Local and remote are separate copies — apply to both, explicitly:

```bash
# 1) inspect what each environment still needs
npx wrangler d1 migrations list telbot-db --local
npx wrangler d1 migrations list telbot-db --remote

# 2) always LOCAL first: typecheck+tests, then real dev run
npm run db:migrate:local && npm test && npm run dev   # + /health check

# 3) PRODUCTION — run BEFORE the deploy that expects the new schema
#    (wrangler applies pending files in name order and records them; it
#     NEVER re-applies the table-rebuild migrations — they are not idempotent)
npx wrangler d1 migrations apply telbot-db --remote
```

**Golden rules**

1. Migrations are **append-only**: never edit or re-number `0001…0013`; a new
   change is a new file `0014_*.sql`.
2. New config docs seed with `INSERT OR IGNORE` + `json_valid` value, schema
   version field, and a provenance comment (follow `0013`'s style, and its
   conditional-`updated_by` etiquette).
3. Extending a CHECK list? Use the rebuild pattern (new table → copy → drop →
   rename) exactly as 0006/0007/0011 — and remember it's once-only, ordered.
4. Destructive/shape-changing migrations must ship a **deploy-backfill** like
   0008/0009 did for live data (idempotent, `INSERT OR IGNORE`, tested e2e).
5. D1 has no transactional rollback: test every migration against a local copy
   first (`--local`), and keep each migration's blast radius to one concern.
6. Applied vs pending on an existing production DB is **not determinable from
   the repository** (the shipped `database_id` is a placeholder) — verify with
   `migrations list --remote` on the actual account.

## 4. Seed & default summary

| Doc | Final seeded content owner | What an operator must change before go-live |
| --- | --- | --- |
| ladders | volume `0003`, duration `0006`, devices `0012` | enable/disable presets, ranges (or leave {10,30,50,100,500}/{30,60,90}/{1,2,3}) |
| `pricing` (schema 2) | `0011` | every number (placeholders) — use `/pricing`, not SQL |
| `payment_info` | `0004` | holder/iban/instructions; card = secret `PAYMENT_CARD_NUMBER` |
| `provisioning` | `0005` | `group_ids` to real panel groups; `username_prefix`; `enabled` |
| `renewal` / `wallet` / `referral` | `0006`/`0007` | policy numbers, or flip `enabled` |
| `sales` | `0013` | nothing — operate via `/sales` (CAS+audit) |

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/database.md)
