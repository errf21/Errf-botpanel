# Payment, Wallet & Referral — English

🇬🇧 English · [🇮🇷 فارسی](../fa/payment-wallet.md) · [index](README.md)

Code truth: `src/handlers/payment.ts`, `src/admin.ts`, `src/db/orders.ts`,
`src/catalog/payment.ts`, `src/handlers/paymentReminders.ts` (8C),
`src/db/wallet.ts`, `src/catalog/wallet.ts`, `src/handlers/wallet.ts`,
`src/db/referrals.ts`, `src/lib/referralPayout.ts`.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Manual card-payment flow (the whole lifecycle)

```
order created (pending_payment) → instructions shown →
customer uploads receipt (photo/document) →
order → awaiting_review; receipt + summary forwarded to EVERY admin
(admin id set = ADMIN_CHAT_ID ∪ is_admin rows) →
admin taps ✅ تأیید پرداخت  OR  ❌ رد on the forwarded message, in /pending,
or in the 8C digest (all the SAME callbacks/code path) →
✅ approved → customer notified → provisioning via waitUntil (PasarGuard)
❌ rejected → admin asked for a reason (typed ≤200 chars, sanitized, or «skip»
default; prompt lives in admin_actions 15-min TTL, one pending per admin) →
customer notified with the reason → wallet credit refunded in the same
transaction batch (guarded UPDATE + order_refund ledger row — winner-only,
exactly-once by construction)
```

- Transitions are single guarded UPDATEs (`WHERE state='awaiting_review'` +
  affected-row check): double taps / two admins can never process once — winners
  audit `payment_approved|payment_rejected` with `actor='admin:<id>'`; losers get
  a neutral toast, admin message edited to neutralize dead buttons. Every admin
  action resets the customer's conversation to IDLE.
- **Verification is always manual** — no bank/gateway callback exists; only the
  admin's eyes on the receipt.

## 2. Payment instructions & configuration

- Rendered from `payment_info` doc (`schema:1`: `holder`, optional `iban`,
  `instructions`) **plus the `PAYMENT_CARD_NUMBER` secret** — the secret is the
  ONLY card source at runtime. The seeded `card_number` placeholder in D1 is
  ignored by the loader; it should be considered dead (the 0004 seed placeholder
  must never be relied upon).
- Fail-closed: secret missing/invalid ⇒ customer sees the «not available —
  contact support» notice and a `payment_card_secret_unconfigured` event is
  logged (value never logged).
- Card/IBAN/URLs render as Telegram HTML **inline code** (tap-to-copy +
  one-time «کپی» hint); HTML parse is opt-in ONLY for those bubbles; every
  dynamic string passes `src/telegram/format.ts` escaping.
- `instructions`/`holder` are admin-authored content rendered **verbatim** — no
  bot translation; for a bilingual operation, put the intended audience's text
  (or both languages) in the doc (no redeploy needed).
- Payment configuration knobs that DO exist: `payment_info.holder/iban/instructions`
  (D1 doc) and `PAYMENT_CARD_NUMBER` (secret). Payment config knobs that do
  NOT exist: gateway keys, auto-verify, payment webhooks, multi-currency, partial
  card payment by receipt… (wallet partial-pay is different: §4).

## 3. Receipt review reminders (Phase 8C)

- Triggered by the same 5-minute Cron (Worker `scheduled`), independent sweep.
- Anchored at the **first** receipt upload per order; stages fire at
  ≥15/≥30/≥45 min of still being `awaiting_review` — **max 3 customer nudges,
  never early, catch-up sends only the topmost due stage** (no burst).
- Claim-first, at-most-once: one `payment_reminders` row per order (PK,
  INSERT OR IGNORE — a replacement receipt cannot re-anchor a schedule); each
  stage claimed by a single guarded UPDATE whose fused subquery re-checks
  `state='awaiting_review'` — overlapping runs/replays/approvals converge on one
  winner. A crash after a won claim loses that nudge (deliberate: duplicates are
  worse).
- Admin gets ONE consolidated digest per sweep run reusing the same
  `adm:ok|adm:no` keyboard — approvals from the digest go through the unchanged
  review path. Renewal receipts ride the same path; never-reviewable orders
  (full-wallet, abandoned) never anchor a schedule.

## 4. Wallet (ledger-backed; customer never pays the panel with a wallet directly)

- **Balance**: `customers.balance_irt` (integer, CHECK ≥0) is a mirror;
  `wallet_entries` is the audit truth (append-only, `delta_irt ≠ 0`,
  `balance_after ≥ 0` recorded from the row after the write).
- **Every move of money is one guarded UPDATE** (`WHERE balance_irt >= |delta|`
  / cap clauses), re-classified on 0-rows-changed into insufficient / cap /
  state, always paired with a `wallet_entries` INSERT. Order
  payment/refund batch UPDATE+INSERT (+ the order transition) in a single
  `db.batch`; admin grant/debit runs the guarded UPDATE and appends the ledger
  entry from the re-read balance.
- **In:** admin `/credit <tg_id> [amount]` (arm → confirm typed amount within
  `wallet.max_credit_irt` cap), referral payout `referral_reward`
  actor=`system`. **Out:** admin `/debit` (within `max_debit_irt`), order
  payment `order_payment`, refund `order_refund`.
- **Order payment from wallet:** `wlt:full` ⇒ balance ≥ total, order born
  `approved` (`verified_by='wallet'`), no receipt, straight to provisioning;
  `wlt:part` ⇒ remainder ≥1 paid by card later with remainder-only instructions.
  Debit claimed against the draft `order_token` BEFORE creation (NOT EXISTS +
  partial UNIQUE `idx_wallet_payment_once` kill double-pay even under true
  concurrency); re-pointed to the order id after; any failed checkout path has a
  converging refund claim (`refundOrderWalletPayment`) that can neither double-
  nor lose-refund.
- **Kill switch & caps**: doc `wallet {enabled, max_credit_irt, max_debit_irt}`;
  missing/malformed ⇒ "wallet unavailable" everywhere (fail-closed for money).
- Wallet interaction with sales stop: gates fire **before** debit; a stop can
  never consume credit (see [Pricing](pricing.md)).

## 5. Referral engine

- Code: 12 chars Crockford base32, minted on demand (`UPDATE ... WHERE referral_code
  IS NULL` + retry on collision, converges under races). Invite link
  `https://t.me/<bot>?start=ref_<code>` (bot username via cached `getMe`).
- Attribution: **first touch, first-ever `/start` only**, guarded
  `WHERE referred_by IS NULL`, self-referral rejected. Attribution ALWAYS works
  (no config needed); payout is what's policy-gated.
- Reward: `floor((order.amount + wallet credit from snapshot) × reward_percent / 100)`
  on the referee's **first approved purchase** (renewals excluded), integer math
  only. Paid **post-approval** from both approval entry points (admin ✅ and
  wallet auto-pay) via `payReferrerIfDue`.
- Exactly-once-per-referee by PK (`referral_rewards.referred_customer_id`);
  per-referrer lifetime `max_rewards_per_referrer` enforced inside the same
  guarded `INSERT ... SELECT` (plus `c.referred_by != c.id`). Any config absence
  ⇒ silent no-op (never blocks approval itself); a failed credit leaves the
  reward row for admin reconciliation (`referral_credit_failed` log).
- Doc `referral {enabled, reward_percent, max_rewards_per_referrer}`.

## 6. Support tickets (payment & service escalations)

Open (`menu:support` → state `WAITING_SUPPORT_MESSAGE` → ticket created, one
live per customer enforced by partial UNIQUE) → messages appended (customer text
or photo/document; forwarded live to all admins with 💬/🗂 buttons) → admin reply
(`tsk:rp` arms a per-admin prompt; typed reply sanitized ≤2000, delivered +
stored, `sender='admin:<id>'`) → status flips open↔answered; close via
`tsk:cl` or by admin; ticket history via 👁 details. Customer session resets
around ticket steps like everywhere else; `/help` explains the flow.

## 7. Announcements (operationally adjacent to payments)

`/announce [text]` (or button flow) → composing state → draft saved → preview +
📢 confirm → **seed-once delivery rows, one per already-registered customer**
(`INSERT ... SELECT FROM customers WHERE NOT EXISTS ...`; composite PK
(announcement,customer) makes re-runs safe and double-sends unrepresentable) → chunked
send with `ann:ct` continue button when a chunk cap is reached;
`/announcements` re-lists last 5 jobs with progress (`sent_count`/`total_estimate`).
`total_estimate` is exactly that — an estimate, not a delivery guarantee claim.

## 8. Money-safety invariants (what tests pin down)

- No float money; no order can exist whose amount differs from its snapshot.
- No double payment of one order (3 layers); no double refund; no refund on
  "unknown" (only confirmed-miss); no admin command can move money unguarded
  past the caps.
- Approval ⇒ payout attempt is silent-safe; rejection same-batch refund; sales
  stop never eats credit; reminders never fire before their stage; notices never
  re-arm after renewal extends (one-per-service promise stands).

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/payment-wallet.md)
