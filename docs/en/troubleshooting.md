# Troubleshooting — English

🇬🇧 English · [🇮🇷 فارسی](../fa/troubleshooting.md) · [index](README.md)

Symptom → likely cause → check → fix. Every **Check** uses real commands.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## A. Configuration & webhook

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| Bot silent to everything | webhook missing/wrong URL/stale secret | `getWebhookInfo`; `curl https://<worker-url>/health` | re-`setWebhook` with correct URL + CURRENT `TELEGRAM_WEBHOOK_SECRET` ([telegram](telegram.md)) |
| Webhook returns `503` | `TELEGRAM_WEBHOOK_SECRET` unset in production | `npx wrangler secret list` | `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` |
| Telegram side shows `last_error_message: "401: Unauthorized"` | webhook secret mismatch (rotated one side only) | compare setWebhook `secret_token` vs Worker secret | align + re-register (Telegram retries meanwhile) |
| `/health` says `telegram_token:false` yet menu works oddly | token unset/typo | secret list + tail logs | re-put token |
| Panel URL edits have no effect | value fails strict validation: `https:` only, no path, no embedded credentials (`pasarguard/client.ts:138-163`) | reproduce with a curl to the same origin | fix the var to the bare origin |

## B. Cloudflare / D1 / migrations

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| `/health` = `degraded`, `d1:"error"` | binding broken: placeholder `database_id` left, wrong account, deleted DB | `npx wrangler d1 list` | paste real id / recreate `telbot-db`, redeploy |
| Deploy error "database not found" | `wrangler.jsonc` name ≠ actual D1 (`telbot-db`) | `d1 list` | align, redeploy |
| Runtime errors: no such column / missing settings doc | deployed code ahead of migrations (or migration apply failed mid-way) | `npx wrangler d1 migrations list telbot-db --remote` | apply pending **then** deploy; if an apply failed mid-file: D1 tables for rebuild migrations are NOT transactional — manually complete/undo only that migration's table swap on a scratch copy first ([deployment](deployment.md)) |
| Cron sweeps seem dead | `wrangler dev` never fires crons (by design) | prod dashboard Triggers tab | test locally by invoking sweeps (as tests do); on prod the `*/5` cron deploys with the Worker |
| D1 writes fine locally but remote rejects JSON | local & remote DBs drifted | compare `SELECT key,value FROM settings;` both | apply the missing migrations/docs to the right env |

## C. Flows & UI behavior

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| Reply-keyboard tap does nothing | custom client text breaks exact-match label routing | `wrangler tail` | press `/start` (re-render canonical labels) |
| Button tap → neutral toast only | stale button (state moved on) or a forged/foreign-id callback (allowlist/ownership) | guarded claims log 0-row attempts | expected behavior — refresh the queue; never "fix" by weakening guards |
| "Catalog unavailable" / "temporarily unavailable" | pricing coverage hole (unpriced reachable option), malformed ladder/pricing doc | `/pricing` view as admin; `settings` docs; `pricingCoverageError` codes in logs | restore a priced ladder via `/pricing`+D1 doc edits; malformed docs degrade safely until fixed |
| Customer claims price differs from earlier screen | order snapshots are immutable (`orders.selections`) | compare `amount` vs later table | as designed — edit prices only going forward; never SQL-tune an order's amount |
| Receipt "ignored" | sent outside `WAITING_PAYMENT_RECEIPT`, or media failed validation | order state; tail | customer resumes flow from the order card (`menu:orders`) — order still `pending_payment`; session TTL 24 h |
| User gets no bot messages at all | they blocked the bot (Telegram 403); sends fail-closed for display text but money state already committed | send-result `null` handling in tail | unblock at their side; service (if approved) already exists — the subscription link also lives in My Services |
| Old-locale keyboard acts "wrong"? | it shouldn't — routing spans both locales | `i18n.test.ts`-documented behavior | no action; a bug here is a CODE bug, not config |

## D. Payment / wallet / referral

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| "Payment info unavailable — contact support" for customers | `PAYMENT_CARD_NUMBER` missing/invalid (fail-closed; D1 field ignored by design) | `/health`, event `payment_card_secret_unconfigured` | put the card secret; retest one instruction render |
| A forwarded receipt visible to some admins not others | admin targeting = env ∪ `is_admin` rows; `is_admin` lookup failure degrades to env-only | customers table; env value | fix id/flag; check D1 health when drift appeared |
| Wallet shows "insufficient" though user "sees" balance | stale view vs guarded UPDATE truth; concurrent op won | `wallet_entries` for the customer | display re-read; if ledger+balance truly disagree → reconcile with one audited `/credit`/`/debit`, never raw balance UPDATE |
| Rejected order "no refund" | order wasn't wallet-paid (nothing to refund) OR refund was `order_refund` already in same batch | `SELECT * FROM wallet_entries WHERE order_id='<id>'` | if proven missing after the batch audit → one `/credit` with settings/order-event cross-note; hand-research first |
| Reminders sent too early/late/burst | cron drift ≤ one interval is expected; never early, at-most-once stages | `payment_reminders.reminded_stage`, anchor events | as designed (3 max; catch-up sends topmost due stage only) |
| Referral reward "not paid" | silent no-op by design: `referral` doc disabled/malformed → `reward_percent` floor 0 → per-referee PK exists → lifetime cap hit → renewal-only referee → credit step failed (`referral_credit_failed` in tail) | `referral_rewards`, `settings.referral`, order events | fix policy; reward is deliberately never forced; a stranded reward row + failed credit is reconciled by an audited `/credit` |

## E. Provisioning / PasarGuard

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| Approved orders never get a link; `/failed` empty; orders park in `approved` | provisioning no-op skip: key/URL unset, `provisioning` doc missing/malformed/`enabled:false` (renewals additionally `renewal` doc) — skips happen **before** any claim (zero writes) (`provision.ts:411-445`) | `wrangler tail` (`provision_config_unavailable code=…`, `panel_key_or_url_missing`…), settings docs | fix config; **known limitation: nothing re-triggers an order parked in `approved`** — the retry UI only claims `failed`. Recovery is a deliberate *manual* edit (documented, audited): revert that order's state to `awaiting_review` (`UPDATE orders SET state='awaiting_review', updated_at=… WHERE id='<ULID>' AND state='approved'`) so the admin ✅ re-runs the normal claimed path — or leave it and refund via reject path if the customer prefers |
| Order `failed` on approve | panel call actually errored: auth(401/403)/timeout/network/rejected(4xx)/server(5xx)/parse, or attempt cap | `/failed` queue (reason ≤200 chars, sanitized), tail (names only) | 🔁 retry (attempts cap `provisioning.max_attempts`); fix root cause (key, group_ids real?, panel down). Repeated failures with `rejected`+detail → payload mismatch vs panel docs: re-verify the 4 endpoints/§3 payloads of [PasarGuard](pasarguard.md) |
| Service got created but no link sent | create succeeded, link read unavailable on that response — code confirms via `GET by-id/by-username`; check `subscription_url` stored vs customer message race | order row: `completed` + `subscription_url` | if URL NULL though user exists: adopt-path stored it later or panel lacks it — give customer link from panel page; My Services refresh re-reads when available |
| "Service not found" (panel) while bot still lists it | service deleted on panel side | detail screen live read result | expected degrade: statuses come from D1 snapshot; panel removal isn't synced back as cancel (no such feature) |
| Renewal "succeeded" but expiry unchanged | renewal apply is claim→PUT→verify; failure `renewal_unverified` leaves order `failed`, retryable; bookings forward-only | renewal order state; `renew_target_unix` | 🔁 via `/failed`; a panel that *drops* expire writes shows here — check panel `GET by-username` directly (read-only curl) |
| 409s / duplicate fear | none possible: claim + UNIQUE + adopt-by-username/409 (see [PasarGuard §5](pasarguard.md)) | `pasarguard_username` ownership audit | no action — adopt paths already handled it |

## F. Pricing / sales switch

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| "another admin changed this" on price/sales confirm | **CAS race you lost — by design** (old-doc fingerprint mismatch, zero writes) | `settings_audit` latest rows | re-open `/pricing` `/sales` (re-reads current), redo intent |
| Customers all get «sales stopped» notice though you didn't toggle | a `stopped:true` doc exists (someone toggled; audit names them) or leftover after maintenance | `SELECT value FROM settings WHERE key='sales';`; `settings_audit WHERE key='sales'` | `/sales` → 🟢 resume |
| `/pricing` shows warning "settings doc invalid" but sells work | malformed pricing **edit staging** vs loader — coverage checks fail catalog **closed** | `/pricing`, ladder docs | repair entries/presets until coverage passes (the warning tells which) |
| Toggle "state missing" after D1 surgery | `sales` seed row deleted | settings table | re-run an `INSERT OR IGNORE` clone of `0013`'s statement (single statement), then toggle from UI (it self-repairs malformed docs) |

## G. Deployment / runtime

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| Deploy succeeds but behavior is old (new commands missing) | vars not refreshed / older version live / CDN-like propagation of webhook URL to old worker | `wrangler deployments view`; /health `time` | `npm run deploy` from the right commit; rollback dashboard button to undo |
| Secrets "worked until redeploy" | a deploy without `keep_vars`… this repo sets `keep_vars:true` — suspect: different Worker name/project overwritten | `wrangler secret list` | re-put; confirm you target worker `telbotv2` |
| Errors vanish from logs after a while / can't see a past incident | `wrangler tail` is live-only | Cloudflare dashboard Logs & Analytics (`observability.enabled:true` ships) | query the stored logs |
| High D1 reads/latency | normal by design (every update reads config/state; no memory cache) — watch quotas | D1 read metrics vs free-plan limits | upgrade plan if needed; code intentionally trades reads for correctness |
| "webhook_dispatch_error update_id=…" in logs | swallowed handler failure (ACK stays 200) | same update_id pattern in tail + reproduce via direct POST (dev) | fix root cause; DB guarded claims kept state consistent meanwhile |

> **Anything not in this file**: reproduce in a local `.dev.vars` setup, replay
> the exact update JSON against `wrangler dev` (curl recipe in
> [Development](development.md)), and compare DB
> state before/after. The in-memory D1 test harness can usually become a
> regression test (`tests/phase*.test.ts` style) — that is the expected loop.

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/troubleshooting.md)
