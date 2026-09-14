# Pricing Model & Sales Stop — English

🇬🇧 English · [🇮🇷 فارسی](../fa/pricing.md) · [index](README.md)

Code truth: `src/catalog/pricing.ts` (engine), `src/catalog/pricingDoc.ts`
(admin edit layer), `src/db/pricing.ts` + `src/handlers/pricingAdmin.ts`
(arming/CAS/apply), `src/catalog/sales.ts` + `src/db/sales.ts` +
`src/handlers/salesAdmin.ts` (commercial stop).

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. The model (schema-2 `pricing` document)

All money is **integer**, unit **IRT (Toman)**; no float arithmetic anywhere.
Prices come from admin-defined exact entries — the engine contains **no invented
multipliers and no months×rate arithmetic**:

```
total = time + volume + users

  time   = months == 1 ? base_product.price : duration_prices[months]
  volume = max(0, volume_gb − base_product.gb) × price_per_gb
  users  = user_prices[device_count]
```

| Doc field | Meaning | Validation |
| --- | --- | --- |
| `base_product` `{gb, users, months, price}` | what the base price covers. `users` and `months` must be exactly `1` (declarations); `gb` is **live** (volume threshold). | `pricing:base_product` |
| `price_per_gb` | extra-GB price (charged only above `base_product.gb`) | 1..1e9 |
| `duration_prices` | keyed by month count **≥ 2** (a `"1"` entry would conflict with base → rejected); ≤24 entries, keys `/^[0-9]{1,4}$/`, values 0..1e9 | `pricing:fields` |
| `user_prices` | keyed by device count 1..1000, ≤1000 entries, value 0 legal (seed `"1":0`) | `pricing:fields` |
| `days_per_month` | pure unit bridge days↔months (catalog stays day-based); 1..365 | `pricing:fields` |
| `currency` | 3-letter code stored/echoed in snapshots (seed `"IRT"`) | `pricing:fields` |

Error tokens as emitted by `parsePricing` (`catalog.ts:236-289`): schema
mismatch → `pricing:schema`; contradictory `base_product.users/months` →
`pricing:base_product`; **all** other field/bound violations collapse into the
single `pricing:fields`.

**Cross-document fail-closed coverage** (`loadCatalog` →
`pricingCoverageError`, catalog.ts:298-339): every choice a customer can
actually reach must be priced or the **whole catalog** refuses to serve
("temporarily unavailable" instead of a mid-flow surprise):

- `volume.min_gb ≥ base_product.gb` (nothing sold below what the base covers);
- every enabled duration preset (and, where custom is allowed, **every day** of
  the range) maps to whole months **and** a priced duration entry;
- every reachable device count has a `user_prices` entry (over-long ranges
  bounded: >500 days / >50 devices custom ranges rejected).

## 2. Snapshots & historical orders

The computed breakdown **including the exact applied table entries** is
returned as `PriceBreakdown {schema:2, inputs:{...}, volume_gb, extra_gb,
volume_cost, months, time_cost, user_cost, total, currency}` and stored in
`orders.selections.price` together with the chosen limits
(`catalogLimits`). Later edits (incl. a `/pricing` change that rewrites
duration keys) can never alter a placed order — review, admin summary and
refunds all read the snapshot amount. Renewal snapshots charge time only
(`kind:'renewal'`, no volume/user components).

## 3. Customer display contract

- The customer **sees only the final payable amount**: summary shows
  «💰 قیمت کل» and orders view the final `amount` again (plus their name/date/
  limits as product facts). Wallet mode adds the credit line and **reminder of
  the final remainder only**.
- **Never shown to customers:** `extra_gb` cost, duration component price, user
  surcharge, `user_prices`/`duration_prices` entries, formulas, breakdown, or any
  internal pricing input. The breakdown is backend/audit data (`orders.selections`,
  `settings_audit`).
- Prices render per locale (`۴۵٬۰۰۰ تومان` style vs `45,000 Toman`) but the
  **number** is the same integer.

## 4. Admin pricing surface (`/pricing`)

**Persian operational surface; admins only** — a customer can never receive the
keyboard or a routed `prc:` tap (every path re-checks `ctx.isAdmin`).

```
/pricing → view of live fields (one button per entry, list generated from the
document — new duration/user entries appear with no code change)
  → tap a field (prc:e_<token>) → arms a pending admin_action (15-min TTL)
  → admin TYPES the integer (Persian/Arabic digits normalized; no minus)
     value STAGED server-side (never embedded into a button)
  → ✅ confirm (prc:ok) → re-validate per-field bounds
     (base/gb ≥ 1 and ≤ 1e9; duration/users ≥ 0 and ≤ 1e9)
     → CAS apply: UPDATE settings ... WHERE key='pricing' AND value=<exactly
       the staged document's raw JSON>
       • 0 rows changed → "another admin changed this" — zero writes
       • winner appends full before/after documents to settings_audit
         (action = field token) + settings.updated_by='admin:<id>'
  → ❌ cancel / expired TTL → neutral messages, no effect
```

Field tokens (`pricingDoc.ts`): `base` | `gb` | `d<months>` | `u<count>` — the
ONLY identifiers crossing the UI/DB seam; a forged or stale token fails
`field_unknown`, and `base_product.users/months` + keys + entry counts are
re-frozen via the canonical render round-trip.

## 5. Sales stop / resume (`/sales`) — section 12 contract

**What it is:** a persistent D1 switch — `settings['sales']` =
`{"schema":1,"stopped":bool}` (seed `0013`) — for a **temporary commercial
stop** of paid-service creation: **new purchases and renewals**. Not a
maintenance kill of the whole bot.

**Admin surface:** `/sales` shows state (🟢/🛑), last-changer line, a
malformed-doc warning if any; buttons `sal:stop` / `sal:start` / `sal:view`.
Toggle is a **CAS on the raw stored JSON** (`db/sales.ts`): `WHERE key='sales'
AND value=<oldJson>` → 0 changes = lost race → "another admin" message; winner
appends full before/after to `settings_audit` (`action='stop'|'start'`,
`actor='admin:<id>'`) and sets `updated_by`. Two admins, one winner — audited.

**What stops while `stopped:true` (every refusal shows the same
customer-facing notice):**

- fresh-buy entry (both transports: reply-keyboard label **and** legacy inline),
- `ord:confirm` (order button), `wlt:full`, `wlt:part` (wallet paths),
- every renewal path: entry (`svc:rnw`), duration step, receipt confirm, wallet
  confirm — and the renew button is hidden on the service screen.

**The checkout backstop:** the first statement of both `checkoutOrder` and
`checkoutRenewalOrder` is `isSalesStopped(db) → 'sales_stopped'` —
structurally unbypassable even if a future entry point forgets its own gate.
Gates fire **before any wallet debit**, so a stop can never consume credit; a
toggle racing mid-flow is caught by the backstop and the existing
no-order-means-refund path returns any already-claimed credit.

**What MUST keep working while stopped** (and does — deliberately not gated):
`/start`, existing services (list/detail/refresh/panel page), order history,
receipt upload and admin **approval of orders created before the stop**
(including their provisioning fulfillment — no stranded money), wallet,
account, referral, support, guide, language, announcements, and the admin
surfaces themselves (an admin can always resume; /announce a resumption).
Pre-existing/pending orders are untouched — the switch only refuses **creating
or extending** paid services.

**Fail-open semantics (loader `catalog/sales.ts`):** a missing row, malformed
JSON, wrong schema, or DB error ⇒ **sales ENABLED** (`{stopped:false}`;
malformed flags a one-line warning to the `/sales` view — a toggle repairs the
doc). Only an explicit `"stopped": true` blocks. (Contrast with the catalog,
which fails **closed**: a config glitch can never accidentally halt the
business.)

**State handling:** the switch lives only in D1, read fresh on every webhook —
no worker memory, survives restarts/redeploys by construction; a toggle is
immediately visible to every request.

## 6. Renewal pricing behavior

Renewal re-charges **the same admin duration table** and nothing else
(volume/users of the existing plan are not re-sold); the renewal's own order
row carries a duration-only breakdown snapshot (`total = time.price`), so a
later edit to `duration_prices` never changes placed renewal orders or
their pending reviews. Renewals are refused while sales are stopped and when
`renewal.enabled=false` (kill switch) or the renewal doc is malformed
(fail-closed "unavailable").

## 7. What admins must do

1. Set real numbers via `/pricing` (seed values are placeholders).
2. Verify reachability: the coverage checker will **refuse to sell** rather
   than underprice — if `/pricing` edits create a hole (e.g. preset enabled
   without entry), fix entries or presets in the ladders.
3. Use `/sales` stop before panel maintenance/capacity events; check
   `settings_audit` for exactly who changed what, when, with full before/after.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/pricing.md)
