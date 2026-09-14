# Telegram Setup — English

🇬🇧 English · [🇮🇷 فارسی](../fa/telegram.md) · [index](README.md)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. BotFather

```
/start with @BotFather  →  /newbot
  - display name       → your service's name
  - username           → whateverbot (must end in "bot")
  - returns the bot token
```

Recommended (matches how this codebase behaves):

- **Privacy mode**: commands and menus are all 1-to-1 chat; privacy mode can
  stay default ON (bot only needs private chats). No group flows are implemented.
- **Commands menu** (optional polish — the bot works without it; it is pure
  BotFather metadata, the router parses commands in `handlers/commands.ts`):
  `/start`, `/help`, `/cancel`, and for admins `/pending`, `/failed`, `/tickets`,
  `/announce`, `/announcements`, `/credit`, `/debit`, `/pricing`, `/sales`.
- **Description/about**: whatever you like — the bot's own `/help` text comes
  from the code bundles (`src/telegram/texts.ts` / `texts.en.ts`).

## 2. Token → secret

The token is **never** in code, never in `wrangler.jsonc`, never logged.

Production:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# paste the token when prompted (input hidden)
```

Local: put it in `.dev.vars` (gitignored; template `.dev.vars.example`).

## 3. Pick a webhook secret

Choose a long random string yourself (Telegram simply echoes it back in the
`X-Telegram-Bot-Api-Secret-Token` header; the Worker compares it
constant-time — `src/routes/webhook.ts`, `src/lib/security.ts`):

```bash
openssl rand -hex 32      # or any strong random generator
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Until this secret is configured, the webhook endpoint fails **closed** (HTTP
503) and no update is processed. With a wrong header: 401.

## 4. Register the webhook

After the Worker is deployed and `/health` is `healthy`:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  --data-urlencode "url=https://<worker-subdomain>.workers.dev/telegram/webhook" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
# → {"ok":true,"result":true,"description":"Webhook was set"}
```

Notes:

- The path is exactly `/telegram/webhook` (`POST` only — routing in `src/index.ts:20`).
- If you use a Custom Domain / route instead of `*.workers.dev`, point the URL
  there; the Worker accepts `X-Forwarded-Proto`-independent paths as long as
  the path matches.
- Telegram retries on non-2xx; this Worker **always ACKs 200** after auth — so
  keep failures inside the handler (the code already does).
- Local development with `wrangler dev` does not need a webhook registration;
  drive it by POSTing a JSON Update with the secret header directly (curl
  example in [Development](development.md)).

## 5. Verification

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Expected: `url` = your Worker webhook URL; `pending_update_count` = 0 (or small
in-flight); **no** `last_error_message`; `has_custom_headers: true` only if you
set them (this project relies on the standard `secret_token` mechanism).

Live verification after registering: open the bot in Telegram, press `/start`
— the main menu (10 buttons, first row = the three colored ones, Persian default) must appear. `npx wrangler tail`
shows error lines if anything failed (`webhook_dispatch_error ...`).

To remove/rotate: `deleteWebhook`, re-set secret, re-register with the new
secret token. Registration order = rotate secret first or in-flight updates
briefly 401 — acceptable for this bot since nothing is lost (Telegram
retries).

## 6. Admin chat targeting

`ADMIN_CHAT_ID` (`wrangler.jsonc → vars`) = the **single** primary admin numeric
Telegram user id. Additional admins are rows with `customers.is_admin=1`
(they must have pressed `/start` once so their row exists):

```bash
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id, telegram_user_id, first_name FROM customers WHERE first_name LIKE '%you%';"
npx wrangler d1 execute telbot-db --remote --command \
  "UPDATE customers SET is_admin=1 WHERE telegram_user_id='<their numeric id>';"
```

Receipts/forwards and the 8C digest go to `ADMIN_CHAT_ID ∪ all is_admin rows`
(`src/db/customers.ts` `resolveAdminChatIds` — a DB failure degrades to
env-only targeting, never crashes the update).

## 7. Production considerations

- **Bot API 8.0+ features used**: reply-keyboard button `style` is sent with
  zero-cost backward compatibility (older clients ignore it, `src/types.ts:148`).
- HTML `parse_mode` is **opt-in per message** only for the copy-friendly card /
  IBAN / URL bubbles (Phase 8C); everything else is plain text (no
  injection-surface parsing).
- The token in `.dev.vars` **must not equal** the production token; never run
  `wrangler dev` pointed at a real production bot while you experiment.
- If the bot was previously in polling mode, `deleteWebhook` is not
  enough — stop any `getUpdates` poller first (Telegram refuses webhook while
  polling is active: `409 Conflict: terminated by other getUpdates`).

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/telegram.md)
