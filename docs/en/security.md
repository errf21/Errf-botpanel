# Security Model — English

🇬🇧 English · [🇮🇷 فارسی](../fa/security.md) · [index](README.md)

Everything here is implemented in the current code (files cited); nothing is
aspirational.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Secrets handling

| Secret | Transport | Never-appears-in |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | outbound HTTPS to api.telegram.org | code, git, logs, D1, Telegram messages |
| `TELEGRAM_WEBHOOK_SECRET` | inbound header check only | logs, messages, docs |
| `PASARGUARD_API_KEY` | `x-api-key` header, HTTPS only | logs, Telegram text, D1 |
| `PAYMENT_CARD_NUMBER` | rendered ONLY into payment instructions bubbles | D1 card field (ignored by loader), logs (only `payment_card_secret_unconfigured` event name appears) |

`.dev.vars` is git-ignored; template is `.dev.vars.example`. Production stores
them as Worker secrets (wrangler). Rotation = re-put secret + redeploy/restart
propagation; panel keys rotate in the panel UI.

## 2. Inbound webhook authentication (fail-closed)

`src/routes/webhook.ts`: unset secret → **503** (nothing processed); wrong
missing header → **401** via `timingSafeEqual` (constant-time XOR accumulate,
length-leak-only early return, `src/lib/security.ts:28-38`); invalid JSON →
400; authenticated updates always ACK 200 after containment (prevents Telegram
retry storms while errors go to logs). Only paths `/health` (presence booleans
only — no values) and the webhook exist; everything else 404.

## 3. Input validation (hostile-callback posture)

Callback data = user-editable wire data → **allowlist everything**
(`src/lib/validate.ts` + `src/telegram/menu.ts`):

- Generic pattern `^[a-z]{2,6}:[a-z0-9][a-z0-9_]{0,23}$` + fixed-namespace
  allowlists (`menu:*`, `act:*`, `step:*`, `ord:confirm`, `cfg:auto`, `wlt:*`,
  `gud:*`, `lang:fa|en`).
- ULID-carrying namespaces get dedicated strict parsers (`adm:(ok|no|skip|rt):`,
  `svc:(det|ref|rnw):`, `tsk:(rp|cl|vw):`, `ann:(go|ct):`) requiring exactly the
  28-char Crockford-base32 id pattern they were minted for.
- `prc:` and `sal:` have their own grammars (`prc:e_<token>` / `prc:menu|ok|no`;
  `/^sal:(view|stop|start)$/`) — nothing else routes.
- Media: file_id `/^[A-Za-z0-9_-]{1,255}$/`; photos use the largest rendition;
  garbage → null (a forged/oversized id never reaches D1).
- Free text (config name ≤64 no leading `/`, payment reference ≤128, reject
  reason ≤200, ticket body ≤2000, announcement body ≤2000) — control chars
  stripped; numeric inputs normalize Persian/Arabic digits + separators and
  hard-cap (≤8 or 12/13 digits downstream), signs only where intended
  (wallet), minus never parses for prices.
- Option values from keyboards (`vol:30`, `dur:60`, `dev:2`) are re-validated
  against the **freshly loaded catalog** every time — buttons are hints, not
  truth. Config names are display-only and can never reach the panel.
- Structurally: Telegram HTML output only where needed, every dynamic string
  escaped (`src/telegram/format.ts`); SQL exclusively via prepared statements
  with `.bind()`; the JSON `settings` docs are `json_valid`-CHECKed; JSON
  parsed defensively everywhere.

## 4. Authorization

- Admin = `ADMIN_CHAT_ID` **or** `customers.is_admin`: computed once per update
  AND re-checked inside every admin handler/callback branch (defense in depth —
  a non-admin can't reach an admin keyboard anyway, and foreign/forged payloads
  produce a neutral toast + zero side effects).
- Service actions (`svc:*`) enforce ownership **inside the WHERE clause**
  (`customer_id` in the claim), so cross-user forged ids leak nothing.
- No RBAC tiers exist; there is no "user role" system beyond the admin flag —
  don't invent privilege flows.
- Refunds/payouts/provisioning trigger exclusively behind admin-action winners
  or system paths; none is callable from any customer keyboard.

## 5. State & concurrency integrity (CAS, guards, idempotency)

- Order lifecycle transitions are single guarded UPDATEs with `state=` in the
  WHERE + affected-rows check; only winners run side-effects (notify,
  provision, refund) — double-taps/two-admins converge.
- Provisioning claims embed the attempts cap in the UPDATE itself;
  panel-username/id UNIQUE columns + claim-before-write make duplicate panel
  services impossible by design; renewal targets are claimed absolutely
  before the PUT and adopted-then-verified — ambiguous writes converge, never
  stack.
- Order creation: session token → `idempotency_key` partial UNIQUE →
  race-winner re-read; wallet payment: NOT EXISTS guards + partial UNIQUE
  `order_payment` index; refund claims similarly guard the `order_refund` row
  and even RE-APPLY a lost credit (no double / no lost refund).
- Webhook replays: the `update_dedupe` PK violation is caught first thing in
  the pipeline (`db/dedupe.ts`) and dispatch short-circuits before anything
  else runs. Notifications/reminders: PK/composite-PK claim tables
  (at-most-once by design; leases handle crash self-healing).
- Admin prompts: one armed action per admin (`admin_actions` PK), 15-min TTL,
  expired prompts swept; staged money values live server-side in the prompt
  (never inside keyboard payloads).

## 6. Money safety

Integer-only everywhere with overflow-rejecting checks (`Number.isSafeInteger`
+ per-field/table upper bounds up to 10¹²); balance mutations guarded against
negative (plus caps on admin ops); `balance_after` re-read from the row for
ledger exactness; snapshot amounts are immutable (config edits cannot move
placed orders); payment verification manual by design — **no code path trusts
an unverified payment**; wallet gates run strictly before any debit.

## 7. Fail-open vs fail-closed matrix (exact current behavior)

| Config/problem | Behavior | Reason |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_SECRET` missing | **closed** (503) | unauthenticated updates are meaningless |
| `PAYMENT_CARD_NUMBER` missing | **closed** (instructions unavailable notice) | never show a wrong/default card |
| catalog/pricing malformed or coverage hole | **closed** ("temporarily unavailable") | never sell under a broken/unpriced ladder |
| `provisioning` doc missing/malformed/disabled, env key/URL absent | **closed** no-op (orders park; zero writes) | never call panel half-configured |
| `renewal` / `wallet` / `referral` docs missing/malformed | **closed** for that feature (renewals/wallet/referral payouts unavailable) | kill switches are money-adjacent |
| `sales` doc missing/malformed/DB error | **OPEN** (sales ENABLED) | a config glitch or DB blip should not halt the business; only an explicit `stopped:true` blocks — CAS toggle repairs malformed docs |
| panel detail-read failure in My Services/sweeps | degrade to D1 snapshot (availability-first) | display only, never a money decision |
| `customers.is_admin` lookup DB failure (admin list) | degrade to env-only ADMIN_CHAT_ID | forwards must keep flowing |

## 8. Webhook & Telegram-specific considerations

- One webhook, `secret_token` handshake; rotate secret with redeploy +
  `deleteWebhook`/`setWebhook`. Workers have no session — all state in D1.
- All Telegram sends tolerate 4xx (blocked user etc.) without corrupting order
  state (send result `null` semantics used by claims: e.g. notification `sent`
  only after Telegram confirms).
- The webhook endpoint is the bot's only real public surface; `/health` exposes
  booleans + D1 liveness only.
- Observability: Cloudflare `observability.enabled=true`; `wrangler tail` logs
  contain event names only, secrets are never interpolated into log lines
  (enforced at call sites — panel `detail` strings sliced 200 & stripped,
  errors logged by `name`).

## 9. What is NOT protected (know your boundaries)

- Anyone who obtains your Telegram bot token / Cloudflare account / panel admin
  access owns the system (standard platform trust).
- Receipt verification quality = admin judgement (the image can be forged —
  check your bank ledger; the bot cannot).
- Announcement/payment-instruction text typed by admins is rendered verbatim —
  admin accounts are trusted writer roles by design.
- No rate limiting beyond Telegram's own + update dedupe; no anti-spam of
  receipt re-uploads beyond state rules (replace + audit is the implemented
  behavior).

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/security.md)
