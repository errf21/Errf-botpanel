# Customer Guide — English

🇬🇧 English · [🇮🇷 فارسی](../fa/customer-guide.md) · [index](README.md)

How a customer actually uses the bot — screens and behaviors implemented today.
(Persian is the default language; press 🌐 زبان / Language for English — that
page's mirror explains the same screens natively: [fa customer guide](../fa/customer-guide.md).)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## Main menu

Press `/start` once — from then on a reply keyboard sits below the chat
(10 buttons; the three coloured ones — red buy, blue services, green wallet — share the first row).
Android Back hides it, and Telegram's own keyboard button brings it back whenever you want.
`/help` explains it again. `/cancel` returns to the menu from any
step (never deletes your orders or services).

| Button | Purpose |
| --- | --- |
| 🛒 Buy a service / خرید سرویس | Start a purchase. |
| 📦 My Services / سرویس‌های من | Active subscriptions, expiry, traffic, renew. |
| 💳 My Orders / سفارش‌های من | Order history with state + price. |
| 👤 Account / حساب کاربری | ID, username, wallet balance summary, language display. |
| 💰 Wallet / کیف پول | Balance + ledger of movements. |
| 🤝 Invite friends / دعوت از دوستان | Your referral link. |
| 🆘 Support / پشتیبانی | Direct contact with the support account (creates **no** ticket). |
| 🎫 Create ticket / ثبت تیکت | Open a tracked support ticket; continues an open one. |
| 📚 Connection guide / راهنمای اتصال | How to install an app and import your config. |
| 🌐 زبان / Language | Switch Persian ⇄ English (permanent choice). |

## Buy a service

1. 🛒 → name your configuration (type any friendly name — display-only, not
   sent to the panel — or tap «خودکار»/auto-pick to generate one).
2. Choose **volume** (e.g. 10/30/50/100/500 GB; typing a number works where
   custom input is enabled), **duration** (1/2/3 months — presets only),
   **devices** (1–3 users). Every screen has «بازگشت»/back and cancel.
3. Summary: name, volume, duration, devices and **one final price**. (Component
   costs are not shown by design — you see exactly what you pay.)
4. «تأیید» confirms. With wallet balance you additionally get 💰 «pay fully from
   wallet» / «partially» buttons.
5. Bank-card instructions appear: card number (tap to copy), holder, amount =
   what you committed to pay. Wallet-partial orders show the **remaining**
   amount here too. (If instructions are configured-off, the bot tells you to
   contact support.)
6. Pay at your bank, then send a **photo or file of the receipt** into this
   chat — the caption is read as an optional reference number.
7. You get a confirmation; a support message arrives with the result:
   ✅ approved → (usually seconds later) your subscription link + a
   «open service page» button; ❌ rejected → the reason; wallet-paid parts are
   auto-refunded to your wallet on rejection.
   If your receipt sits unreviewed, you get a gentle nudge (max 3).

## My Services

Each **completed purchase** is a service card: status (active / expiring soon /
expired), used vs total traffic, valid-until date, config name. Refresh pulls
live panel data when available (never blocks the list). Buttons: renew
(duration presets only, charged the same table as buying time — wallet can pay
too), open the panel service page (the official subscription link), and a
90%-usage reminder + a single expiry reminder are sent proactively per service.

## Renewal details

Renewing can be done before or after expiry; the new period is added to the
**later** of (now, current expiry). Same receipt/admin-review pipeline (or
wallet). Renewals are refused exactly while the store is on sales stop.

## Wallet

There is no self top-up button — balance is credited by an admin (e.g. after
you pay and ask support) or by referral rewards; you spend it at checkout (full
or partial). The wallet screen shows your latest entries (up to 8), each with
kind, amount, and resulting balance. Refunds from rejected orders land back
here.

## Referral

🤝 shows your personal link `https://t.me/<bot>?start=ref_…`. Whoever joins
through it **for the first time** and completes their first purchase: reward =
the configured percent of that order, credited to your wallet automatically
with a notice. Per-program limits apply (a lifetime cap per inviter; one reward
per friend).

## Support

**🆘 Support** opens the direct-contact screen — the official support handle (from
`SUPPORT_CONTACT`); it creates **no** ticket and changes no state.

**🎫 Create ticket** is the tracked flow: write your message (ticket opens; one live
ticket per customer) → keep writing to add details → admins answer here; ✅/ «بستن»
close button appears after admin answers. Attach a screenshot/photo when relevant.
If `SUPPORT_CONTACT` is unset, 🆘 points you at 🎫 instead of inventing a destination.

## Announcements

Announcements arrive as the operator wrote them (the bot does not translate
them — bilingual admins write bilingual text). There is no opt-out switch
implemented; the bot only sends to customers who have interacted with it.

## Connection guide

📚 → pick Android / iOS / Windows → pick the app (Android: v2RayTun or v2rayNG;
iOS: V2Box or Streisand; Windows: Throne) → official store/GitHub links +
60-second import steps (copy subscription link → share/import into the app).
The safety notes (e.g. verify the official installer; SmartScreen advice) are
part of the flow — read them.

## Language

🌐 → 🇮🇷 فارسی / 🇬🇧 English → everything from now on speaks that language
(purchase screens, services, wallet, tickets replies, reminders, guide).
Admin-authored texts (announcements, payment instructions) are rendered as
written by the operator — language selection doesn't translate them.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/customer-guide.md)
