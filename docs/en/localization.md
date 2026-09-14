# Localization (Persian / English) — English

🇬🇧 English · [🇮🇷 فارسی](../fa/localization.md) · [index](README.md)

Code truth: `src/telegram/i18n.ts`.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## Behavior rules — as implemented

1. **Persian is the default for everyone.** A brand-new customer and a
   customer who never chose anything both see Persian.
   Resolution: `customers.language` — `NULL` ⇒ fa; `'en'` ⇒ en; anything else
   ⇒ fa (`resolveLocale`, i18n.ts:22-24). The customer's Telegram client
   `language_code` is stored for the Account screen and **never** selects a
   language (explicit operator decision).
2. **Explicit choice is the only switch.** The 🌐 button → picker
   («🇮🇷 فارسی» / «🇬🇧 English») → tap writes `customers.language`; the
   confirmation message and the keyboard you currently use (menu / composing /
   inline back) immediately re-render in the new language. Language never
   enters the conversation state machine.
3. **One boundary branch.** `uiFor()` returns `{locale, t, f}`; handlers only
   call `ctx.ui.t.*` / `ctx.ui.f.*` — there is no scattered `if (language...)`
   in flows; `texts.en.ts` must compile-mirror the fa `Texts` contract
   (missing key = typecheck error). English copy is authored natively per
   step, not word-for-word translated.
4. **Formatting is locale-owned.** fa: Persian digits, «۴۵٬۰۰۰ تومان»-style
   money, ISO-slice dates with Persian digits; en: Latin digits,
   `45,000 Toman` / `Rials` fallback, `2026-09-14`, `2026-09-14 08:30 UTC`,
   pluralization (`1 device` / `2 devices`, `day`/`days`), duration labels
   computed from `days_per_month`.
5. **Stale keyboards are safe.** Reply-keyboard labels are the routing: exact
   match tables span **both** locales, so an old Persian keyboard tapped after
   switching to English still routes to the right screen (unit-tested
   cross-locale label uniqueness; `lang:` values against a static allowlist).
   The selector button label is deliberately bilingual & locale-fixed:
   `🌐 زبان / Language` (byte-identical in both bundles) — it never needs
   re-routing.
6. **Proactive messages follow the RECIPIENT.** Review results, provisioning
   outcomes, renewal-applied, refunds, referral join notices, ticket replies/
   closure, payment reminders, usage/expiry notices — all resolve the stored
   language of that customer (via the existing customer read, zero extra
   queries). Queue mechanics/claims are locale-independent.
7. **The admin operational surface is Persian-only by design**: `/pending`,
   `/failed`, `/tickets`, `/pricing`, `/sales` views and their keyboards,
   review toasts, ticket relays, announcement job control, the 8C digest.
   Admin-authored **content** is not bot copy: `payment_info.instructions` /
   `holder` / announcement bodies render verbatim — put bilingual text in D1
   yourself if your audience needs it (no code/redploy needed).
8. **Persian-first UX conventions** (persona copy, «درود زیبا» opener on
   notices, Persian emoji-labeled flows) are baseline; English mirrors the
   meaning while keeping its own voice; commands and identifiers are never
   localized; admin-only values inside keyboards stay Persian even on mixed
   chats by design.

## Migration note (0010)

`customers.language` added nullable with CHECK `('fa','en')`, **no backfill** —
every existing user keeps their behavior (NULL = the Persian default); zero
surprise.

## Constraints for contributors / docs

Technical identifiers stay untranslated everywhere — in code, docs, and the
bot UI: commands (`/pricing`), callback values (`prc:e_base`), state names
(`WAITING_PAYMENT_RECEIPT`), settings keys (`provisioning`), env names, file
paths. Persian documentation must keep them exactly as-is in LTR runs.

## Quick self-test matrix

| Actor state | Expected |
| --- | --- |
| fresh user, any Telegram language | 🇮🇷 full Persian UI |
| taps 🌐 → English | everything (menu, flows, texts) instantly English; stays English forever (explicit choice, survives profile churn) |
| same user's new order receipt → admin | admin queue still Persian |
| customer later taps an old Persian keyboard button | routes correctly, screen in English |
| ticket reply from admin (Persian text) | lands in ticket thread verbatim + customer notification composed in customer's language (body as typed — relays are verbatim, notifications are localized) |

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/localization.md)
