# Features — What Is Actually Implemented — English

🇬🇧 English · [🇮🇷 فارسی](../fa/features.md) · [index](README.md)

Every item below exists in the current code (Phases 1–13, one commit each, with
tests). Anything **not** listed here is not implemented — no planned features are
described as available.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## Customer features

| Feature | How it works (code truth) |
| --- | --- |
| **Registration** | First webhook silently upserts the customer (profile fields; never touches `language`). |
| **Main menu (reply keyboard)** | 10 buttons in rows **3/2/2/3**: row 1 = the **three distinct styles** 🔴🛒 buy `danger`, 🔵📦 my services `primary`, 🟢💰 wallet `success` (always adjacent, never split); then 💳 orders, 👤 account, 🤝 invite, **🆘 support (direct contact, no ticket)**, **🎫 create ticket (the tracked flow)**, 📚 guide, 🌐 language. Locale-labeled, cross-locale routing, **non-persistent + one-time** — every tap collapses the panel back to the full chat, the input-bar keyboard icon summons it; catch-all hint replies carry no markup so nothing else re-presents it (`src/telegram/menu.ts`). |
| **Buy a service** | config-name step (free text, sanitized, or `cfg:auto` auto-pick name generator) → volume → duration → devices → summary → confirm. Presets + custom values re-validated against the freshly loaded catalog; keyboard payload values never trusted. |
| **Pricing** | Final total shown only (integer IRT); instant quote; snapshot stored with the order. |
| **Order idempotency** | Confirmation mints a ULID token; replay/double-tap can never create two orders (3 layers). |
| **Payment instructions** | Card holder + card (as tap-to-copy inline code), IBAN (if set), admin-authored instructions text, exact payable amount — sourced from `payment_info` doc + `PAYMENT_CARD_NUMBER` secret. |
| **Receipt submission** | Photo **or** document (largest rendition stored); caption = optional payment reference (sanitized ≤128). Re-upload while `awaiting_review` **replaces** the receipt (audited, re-forwarded). |
| **Order status** | Receipt accepted toast; review outcome (approved/rejected + reason) pushed to the customer; my order-history list. |
| **My Services** (`menu:services`) | Completed purchases with local computed status (🟢 active / ⏳ near expiry (≤`renewal.near_expiry_days`) / ‼️ expired); detail screen enriches with the live panel (status, expiry, used/total) and degrades to the D1 snapshot; opens the panel subscription page (URL button — the bot never builds its own page). |
| **Renewal** | Duration-only ladder (1/2/3 months presets, never custom text) → summary → same receipt/manual-review pipeline **or** wallet pay; charges only the duration table entry; extends from `max(now, current expire)`; expired services renewable; forward-only expiry booking. |
| **Wallet** | Balance view; pay order **full** or **partial** from the summary; admin-granted credit/debit (no customer-side self-top-up exists); refunds on rejection are automatic wallet credits. |
| **Referral program** | Personal 12-char code + `https://t.me/<bot>?start=ref_<code>` invite link; first-touch attribution at first-ever `/start`; reward = `reward_percent` of referee's first approved **purchase** total (incl. wallet-paid portion), credited with a notice; lifetime cap per referrer. |
| **Support tickets** | Open one live ticket (text; `WAITING_SUPPORT_MESSAGE`), follow-up while open, replies from admins relayed to the customer, close, admin-closed notice. File relay supported (photo/document stored on ticket messages). |
| **Announcements (receive)** | Broadcasts sent by admins arrive one-time per customer. |
| **Connection guide** (`menu:guide`) | Stateless screen walk: platform (Android/iOS/Windows) → app (incy, v2RayTun, v2rayNG / V2Box, Streisand / Throne) → official store/repo links + one-minute import steps; both locales; live-verified official links only. |
| **Language switch** (`menu:lang`) | Picker 🇮🇷 فارسی / 🇬🇧 English; writes `customers.language`; confirmation and keyboard re-render in the new language immediately. |
| **/start /help /cancel** | Menu+greeting, help text, safe session reset to menu. |
| **Free test (one per user, EVER)** | 100 MB / 1 day (defaults from the `free_test` settings doc). Offered once on the FIRST-EVER `/start` (a separate inline CTA bubble — the main keyboard shape is untouched) and on the My-Services empty state; claimable via `tst:claim`. Enforcement is the `free_test_claims` PK: repeat taps, replays, races and forged callbacks can NEVER grant a second test — before, during or after expiry. The test order is a zero-amount `purchase` born `approved` (no receipt, no admin queue, no payment reminders, **no referral payout**), provisioned through the standard funnel with a **byte-based** `data_limit` (100 MB sits below the GB ladder), displayed with MB units, and **never renewable** (guarded in `renewableService`; the renew button is hidden). The sales stop blocks fresh claims; a confirmed failure releases only a never-used fresh claim (rebuild converges under the stored order id). Fail-closed config: missing/malformed/disabled doc hides offers and refuses taps with zero writes. |
| **Service notifications** | One 90%-usage notice and one expiry notice (≤3 days) per **paid** service, ever — delivered in the recipient's language with CTAs. A free test never receives the paid set (candidate SQL excludes claimed orders at list AND claim); instead it gets its own **`free_test_expiring`** notice once, ~2 hours before expiry (same lease/PK idempotency; silent if the whole window was missed). |
| **Payment review reminders** | Customer nudges at ≥15/30/45 min after receipt (max 3) while still awaiting review. |

## Admin features

| Feature | How it works |
| --- | --- |
| **Admin identity** | `ADMIN_CHAT_ID` env (single numeric id) **or** `customers.is_admin=1`. |
| **Receipt review queue** `/pending` | Last 10 `awaiting_review` orders with ✅/❌ buttons; forwarded receipts (photo/document) arrive live with the same buttons; re-click after processing → neutral toast, message edited. |
| **Approve** | Guarded single UPDATE (`WHERE state='awaiting_review'`), winner-only side effects: customer notice, auto-provisioning via `waitUntil`, referral payout attempt. |
| **Reject** | Reason prompt (`admin_actions`, 15-min TTL, typing free text ≤200 sanitized, or «skip» default); same guarded transition; **same-batch** wallet-credit refund if the order used wallet. |
| **Provisioning queue** `/failed` | Failed creations with `🔁` retry buttons (+ capped attempts). |
| **Ticket queue** `/tickets` | Live tickets list, per-ticket push forwarding, 💬 reply flow (arm → type reply → relayed to customer), 👁 details, ✅ close. |
| **Announcements** `/announce [text]`, `/announcements` | Draft → preview → confirm (ann:go) → chunked resumable fan-out (continue button; per-customer delivery PK = no double-send; skip/failed tracked); status list of last 5. |
| **Wallet ops** `/credit <tg_id> [amount]`, `/debit <tg_id> [amount]` | Arm (target must be a registered customer) → confirm/amount by typing → guarded apply within `wallet` doc caps (ledger pair written). |
| **Pricing management** `/pricing` | Live values, one button per editable entry (list generated from the document → new entries appear with no code change) → arm → typed amount STAGED server-side → ✅ confirm → **CAS on document fingerprint** → guarded swap + full before/after into `settings_audit` + `updated_by` actor. |
| **Sales stop/resume** `/sales` | Shows state (+malformed warning), 🛑 stop / 🟢 start buttons, CAS toggle + `settings_audit`; gates fresh buys, wallet paths and all renewals server-side + checkout backstop; everything else keeps working (see [Pricing](pricing.md)). |
| **8C admin digest** | One consolidated reminder digest per 5-min sweep run, reusing the same ✅/❌ queue buttons. |

## UI/UX features

- Persian-first persona copy («درود زیبا» style), English authored natively (not
  translated), per-locale money/date formatting (`src/telegram/i18n.ts`).
- Styled reply keyboard buttons (danger/primary/success trio preserved), composing-mode
  keyboards for free-text steps (back-row always present).
- Toast answers to every callback (no silent taps); dead-button neutralization
  on admin messages after review.
- HTML inline-code rendering only for card/IBAN/subscription URLs (tap-to-copy,
  one-time «کپی» hint).
- Inline keyboard label localization for customers; admin operational keyboards
  deliberately Persian-only.

## Explicitly NOT implemented (so nobody expects them)

- Online payment gateways / auto-verification of payments (manual by design).
- Customer self top-up of the wallet (top-up = admin `/credit` or referral reward).
- Multi-admin `ADMIN_CHAT_ID` lists (single id; `is_admin` rows scale instead).
- Panel template management, inbound/outbound config, or any panel setting beyond
  the create/modify fields in §3 of [PasarGuard](pasarguard.md).
- Dashboard/web page of any kind, admin web panel, stats exports.
- Group/channel Telegram features, inline mode, deep-link marketing beyond `ref_`.
- Auto-delete/auto-cancel of stale sessions beyond the 24 h expiry; no admin UI
  for editing `payment_info` text (D1 edit only).
- Anything described only in the (now-former) README "Roadmap" that isn't marked
  ✅ — Phases 1–13 are the whole implemented product; final Cloudflare production
  deployment/webhook registration is a pending **operator** step.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/features.md)
