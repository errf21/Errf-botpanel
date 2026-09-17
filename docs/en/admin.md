# Admin Operations Guide — English

🇬🇧 English · [🇮🇷 فارسی](../fa/admin.md) · [index](README.md)

The admin surface is intentionally **Persian** (operator decision, Phase 10) —
queues, review buttons/toasts, ticket relay, announcement control, pricing and
sales screens are `fa` constants; an English-configured customer never sees
them, and an admin's own choice only affects the customer-facing screens.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. How admins are recognized (exactly as implemented)

An update acts as admin iff **either** (`src/admin.ts:28-36`):

1. `env.ADMIN_CHAT_ID` (set in `wrangler.jsonc → vars`) — a single numeric
   Telegram user id string-equal to the actor's id (whitespace-trimmed; **not**
   a comma list), **or**
2. the actor's `customers` row has `is_admin = 1`.

Computed once per update (`ctx.isAdmin`); every admin handler and every `adm:`,
`tsk:`, `prc:`, `sal:` callback path **re-checks server-side** — a customer
tapping a stale/forged admin button gets a neutral toast and zero effects.

**Adding a second admin:** they must have pressed `/start` once (to have a
row), then:

```bash
npx wrangler d1 execute telbot-db --remote --command \
  "UPDATE customers SET is_admin=1 WHERE telegram_user_id='<numeric id>';"
```

**Removing:** set `is_admin=0`. (Changing `ADMIN_CHAT_ID` requires a vars edit +
redeploy.)

## 2. Command reference (all implemented commands)

| Command | Who | Function |
| --- | --- | --- |
| `/pending` | admin | Review queue: latest 10 `awaiting_review` orders, ✅/❌ per row (`adm:ok`/`adm:no`). Also forwarded receipts arrive push-style with the same buttons. |
| `/failed` | admin | Provisioning-failure queue: latest 10 `failed` orders with `🔁 <id>…` retry buttons (`adm:rt`). Retry claims `failed→provisioning` under `provision_attempts` cap. |
| `/tickets` | admin | Support queue: up to 10 live tickets, each row 💬 پاسخ / 👁 جزئیات / ✅ بستن (`tsk:rp|vw|cl`). New customer messages are pushed live with 💬 + queue button. |
| `/announce [<text>]` | admin | Broadcast: inline arg jumps to draft-save; otherwise composing-mode ladder (type body ≤2000 → preview → 📢 ارسال → chunked fan-out → «ادامه ارسال ➡️» when chunk cap hit). |
| `/announcements` | admin | Status of last 5 broadcast jobs (state, sent/estimate, continue button if unfinished). |
| `/credit <telegram_id> [amount]` | admin | Wallet grant: usage shown if args missing; target must exist by numeric Telegram id (usernames are NOT resolved); flow arm (`wallet_grant`) → typed amount (Persian digits OK) → guarded + capped apply → confirmation with new balance. |
| `/debit <telegram_id> [amount]` | admin | Same as /credit, action `wallet_debit` (guarded, cannot go negative, capped). |
| `/pricing` | admin | Live pricing doc → field buttons → arm (`pricing`, 15-min TTL once per admin) → stage typed value → ✅ ثبت قیمت → CAS apply + `settings_audit`. Full detail: [Pricing](pricing.md). |
| `/sales` | admin | Sales-stop surface: state display (+malformed warning), 🛑 توقف سرویس / 🟢 فعال‌سازی سرویس / 🔄 نمایش دوباره. CAS+audit. [Pricing](pricing.md). |
| `/panel_del <panel_username \| order_id>` | admin | **Delete a provisioned service from the panel (Phase 16).** Resolves the target, shows a confirmation card with full order summary + `🔴` delete / `↔️` cancel (`pdel:ok|no`). Delete = ONE `DELETE /api/user/by-username/<u>` + read-back confirmation; only on confirmed absence D1 stamps the terminal `panel_deleted` disposition (`panel_deleted_at/by` + audit event + customer notice). Failed/ambiguous panel result = NO local change, card stays for retry. Double taps / concurrent admins converge (single stamp). Deleted services and their usernames retire from reuse: never listed, never renewable, never repurchasable, never re-provisionable. History (order, payment, renewals) untouched. Manual panel-side deletions are reconciled automatically (refresh tap / usage sweep 404 → `system:*` actor). |
| `/start` `/help` `/cancel` | everyone (customer UX) | Menu / help / session reset. Admins also use them; they are not admin operations. |

Unlisted commands → «unknown command» reply + main menu.

## 3. Daily workflows

### Review a payment

1. Receipt arrives (photo/document + order summary lines: id, final price,
   product facts; renewal orders clearly marked with service id).
2. Verify against your **bank statement** — the bot never sees your bank; the
   receipt image is evidence, you are the verifier.
3. ✅ تأیید پرداخت → order approved → provisioning runs (customer receives
   subscription link seconds later, or a "being handled" notice if the panel
   failed — check `/failed`).
   ❌ رد → type a reason (≤200 chars) or use the «skip» button (default text) →
   customer notified + wallet credit (if any) refunded automatically.
4. Double-taps and other admins' parallel taps are inert (guarded transitions).

### Recover a failed provisioning

`/failed` → 🔁 retry (attempts capped by `provisioning.max_attempts`). Repeated
failures mean: panel down, `provisioning` doc disabled/malformed, key/URL
missing, or the chosen `group_ids` invalid — see the failed order's short
sanitized reason (`wrangler tail` + `/health` + doc checks; [troubleshooting](troubleshooting.md)).
The service row stays safe; adoption logic prevents duplicate creation even
between retries.

### Answer a ticket

`/tickets` → 💬 on the ticket (or on the live push) → type the answer → relayed
verbatim (sanitized) with attribution-free appearance to the customer; ticket →
`answered` → customer reply flips `open` again (pushed) → close ✅ when done.

### Announce

`/announce متن` → confirm draft → (chunked until done; resume via
`/announcements` or the continue button). Remember: bodies render verbatim in
both audiences' chats — write bilingually if your customer base is mixed.

### Suspend new sales (panel maintenance / exhausted capacity)

`/sales` → 🛑. New purchases + repurchases refuse politely; everything customers
already have keeps working; pending receipts keep being approvable (no stranded
money). To reopen: 🟢 — then optionally `/announce` the resume.

### Adjust pricing (live, no redeploy)

`/pricing` → the relevant field → type the exact integer (Toman) → ✅.
Conflict message? Another admin won the race — view again, re-arm.
Audit anything: `SELECT * FROM settings_audit WHERE key='pricing' ORDER BY id DESC LIMIT 20;`.

## 4. D1 direct edits (no UI for these)

Ladders (`volume_options`, `duration_options`), `payment_info` (holder/iban/
instructions), `provisioning` (group ids, prefix, caps, `enabled`), `renewal`,
`wallet`, `referral` docs — SQL examples in
[Configuration](configuration.md). Always
inspect-before, single-row UPDATE, keep `"schema"` correct, and remember the
cross-validation: pricing coverage rules can fail the catalog **closed** —
test `/health` + a purchase smoke right after edits.

## 5. Operational safety reminders

- Don't share the bot token, webhook secret, panel key or card secret — admins
  in Telegram are a set of **ids**, not passwords.
- The admin digest (8C) and queues reuse the exact review code path — reviewing
  via digest is as guarded as `/pending`.
- `settings_audit` + `order_events` are append-only: you cannot erase a
  decision from the trail (by design); don't try.
- Free-text admin prompts (reject reason, ticket reply, wallet amounts, pricing
  amounts) expire after 15 min (`admin_actions`); a stale prompt simply
  re-asks.
- While `/sales` is stopped, admins still approve pre-stop orders — that's
  deliberate; provisioning of approved pre-stop orders is NOT gated.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/admin.md)
