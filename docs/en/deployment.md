# Deployment & Updates — English

🇬🇧 English · [🇮🇷 فارسی](../fa/deployment.md) · [index](README.md)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 0. Status note (repo truth)

This repository's evidence shows a code-complete Phases 1–13 product, with
`wrangler.jsonc` shipped with `database_id: REPLACE_WITH_D1_DATABASE_ID`.
**Whether a production Worker/D1/webhook exists cannot be determined from the
repository** — treat any account as potentially green-field (first migrate the
real DB id + run the checklist), or audit the live one with the commands below.

## 1. Pre-deployment verification

```bash
git log --oneline -3          # you're deploying what you think you are
npm install
npm run typecheck && npm test # 22 suites — must be green
# wrangler.jsonc:
#   - database_id filled (from: npx wrangler d1 create telbot-db)
#   - vars.ADMIN_CHAT_ID set (numeric id, quoted string)
# secrets present (do NOT print values):
npx wrangler secret list      # expect 4 names; add:
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PASARGUARD_API_KEY      # optional until first sell
npx wrangler secret put PAYMENT_CARD_NUMBER     # required for payment UX
```

## 2. Migration ordering — the hard rule

**Schema first.** Any deployment whose code expects new columns/docs REQUIRES
`d1 migrations apply --remote` to have applied them already (0013's `sales`
doc, for instance: `loadSalesState` fail-opens on missing row, but checkout
gates and `/sales` need the doc to actually be toggleable/audited in the
intended way). The safe universal order:

```bash
npx wrangler d1 migrations list  telbot-db --remote    # inspect pending
npx wrangler d1 migrations apply telbot-db --remote    # apply 0001..0014 in order
npx wrangler d1 migrations list  telbot-db --remote    # confirm: no pending
npm run deploy                                         # THEN deploy the Worker
```

Re-runnable note: the shipped migrations are forward-only, and 0006/0007/0011
contain once-runnable table rebuilds — `migrations apply` tracks applied
files itself, so don't hand-apply or reorder SQL (and never edit applied ones).

## 3. Deploy + webhook + verification

```bash
npm run deploy
curl -s https://<worker-url>/health     # status "healthy", checks true
# webhook (one-time / after bot change): see [telegram.md](telegram.md) §4
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"   # url+p0+no err
npx wrangler tail                       # watch traffic during smoke test
```

Smoke test (minimum): `/start` → buy ladder → summary shows final price only →
instructions show YOUR card+amount → receipt → `/pending` list → approve →
subscription link arrives → `/failed` empty → `/sales` toggle once →
`/pricing` view renders → language toggle → My Services shows the service with
status & page button.

## 4. Updating a live deployment

```bash
git pull                                   # or fetch+checkout the release
git log --oneline HEAD@{1}..HEAD           # READ what changed
git diff --stat HEAD@{1} HEAD -- migrations/  # any NEW migration file?
ls migrations/                             # compare applied-vs-files:
npx wrangler d1 migrations list telbot-db --remote
# if pending migrations exist:
npx wrangler d1 migrations apply telbot-db --remote   # BEFORE deploy
npm run typecheck && npm test
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id FROM orders WHERE state='awaiting_review' LIMIT 5;"  # glance at in-flight
npm run deploy
# secrets only if names changed: npx wrangler secret put ...
# webhook only if Worker URL/bot changed: re-setWebhook with same secret
curl -s https://<worker-url>/health && npx wrangler tail
```

Protect secrets in updates: never re-echo `secret put` prompts into scripts/CI
without masking; `wrangler` stores them server-side; `.dev.vars` stays local.

Cron sweeps need no action (trigger declared in `wrangler.jsonc` and deployed
with it); verify the Worker's Triggers tab or `wrangler deployments view`.

## 5. Rollback & recovery

- **Code**: redeploy the previous commit (`git checkout <sha> && npm run
  deploy`). Cloudflare retains recent versions — use rollback from the
  dashboard as the fast path.
- **Data**: migrations are NOT rolled back automatically (and cannot be —
  rebuild tables). Code-after-rollback must tolerate the newer schema; the
  repo's CHECKs are additive/enums only, which is precisely why this is safe —
  don't introduce destructive migrations without a written recovery plan.
- **Stop-the-world safely**: `/sales` stop (commercial halt) before deeper
  investigation; `deleteWebhook` as the nuclear option (bot stops receiving;
  state stays consistent, no half-processed updates since processing is
  idempotent/guarded).
- **Stuck orders**: approved-but-not-provisioned park safely (no-op paths);
  `failed` retries via `/failed`; never hand-move `orders.state` in SQL to
  bypass guards — the one documented exception is reviving a parked `approved`
  order via [Troubleshooting §E](troubleshooting.md), after which the normal
  claimed/auth audit path applies.
- **Restore data**: take regular exports (maintenance page); worst case
  `d1 restore` (Cloudflare PITR if your plan provides it) or re-import the
  latest export into a scratch DB and repair surgically.

## 6. First-live-day special (provisioning proof)

Before promoting: one **read-only** authenticated probe (`GET
/api/user/by-username/<anyexisting>`) against the panel to confirm host/auth,
then a real end-to-end test order (cheapest ladder entry) and full review +
provisioning walk; afterwards `/failed` empty, service page opens, renewal
ladder reachable, and the test service cleaned/expired.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/deployment.md)
