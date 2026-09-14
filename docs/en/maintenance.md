# Maintenance — English

🇬🇧 English · [🇮🇷 فارسی](../fa/maintenance.md) · [index](README.md)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Scheduled checks (suggested rhythm)

### Weekly (or after every incident)

```bash
# 1) worker alive, D1 reachable, core secrets present
curl -s https://<worker-url>/health | python3 -m json.tool
# 2) stuck orders — anything aging in a non-terminal state
npx wrangler d1 execute telbot-db --remote --command "
  SELECT state, COUNT(*) n FROM orders
   WHERE state IN ('awaiting_review','approved','provisioning','failed')
   GROUP BY state;"
# 3) failed-provision backlog: /failed via admin chat (operators), and:
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id, updated_at FROM orders WHERE state='failed' ORDER BY updated_at DESC LIMIT 10;"
# 4) admin-review debt (8C reminders prove it; check the same via SQL)
npx wrangler d1 execute telbot-db --remote --command "
  SELECT COUNT(*) FROM orders WHERE state='awaiting_review';"
# 5) broadcast jobs unfinished
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id,state,sent_count,total_estimate FROM announcements WHERE state='sending';"
# 6) cron sweeps still running clean (dashboard logs query or during wrangler tail at a :00/:05)
```

Interpretation: `approved` (not provisioning) rows = panel config no-op parking
(recover via [troubleshooting §E](troubleshooting.md)) — worth zero-tolerance;
`awaiting_review` age > a day = forgotten queue, ping admins (or rely on 8C
digest to have nudged already).

### Monthly

- Review `settings_audit` for surprise actors/values:
  `SELECT id,key,action,actor,created_at FROM settings_audit ORDER BY id DESC LIMIT 50;`
- Referral anomaly glance: `SELECT referrer_customer_id, COUNT(*) FROM referral_rewards GROUP BY 1;`
- Wallet distribution sanity: entries vs summed balances must agree:
  `SELECT COUNT(*) FROM wallet_entries;` growth is normal (each entry = event).
- Disk/row scale: D1 metrics tab vs plan limits (reads/minutes) — tune usage-alerts
  or plan, not the code.
- D1 backup (see §3) + test-import one export locally (`d1 execute --local` into
  a scratch DB) — an untested export is not a backup.
- Panel side: confirm groups referenced by `provisioning.group_ids` still
  exist/active in the panel UI.

### Per code-deploy & per config-change

- The deployment checklist's "before/after" lines only
  ([Deployment](deployment.md)).
- After any D1 settings/doc edit: one full smoke purchase in a test chat.

## 2. Safe routine operations

| Operation | How (this project's truth) |
| --- | --- |
| Rotate Telegram webhook secret | `secret put`, then **immediately** re-`setWebhook` with new value, verify `getWebhookInfo` + health + one `/start`. |
| Rotate bot token | create new via BotFather (`/revoke`), `secret put`, re-`setWebhook` with new token+secret, verify. |
| Rotate panel API key | create new in panel admin → `wrangler secret put PASARGUARD_API_KEY` (takes on next Worker isolation boot; provisioning reads env per call) → monitor `/failed` empty during switch → delete old key in panel. |
| Rotate seller card | `wrangler secret put PAYMENT_CARD_NUMBER` + publish the change to customers via `/announce` (operator text!). No D1 field needed (ignored by design). |
| Pause sales for maintenance | `/sales` 🛑 before, 🟢 after, `/announce` resume if desired (audited both directions). |
| Grant/adjust prices | `/pricing` live flow (never SQL for docs with CAS). |
| Add admin | `/start` once then `is_admin=1` UPDATE ([admin guide](admin.md)). Remove: `is_admin=0`. |
| Change catalog ladders/policies | one-doc UPDATE with json intact + smoke ([configuration](configuration.md)). |
| Update Node/wrangler on the maintainer machine | fresh clones are unaffected — lock-pinned via `package-lock.json`; re-run gates (`typecheck`, `test`) after any bump (note: upgrading wrangler via package bump requires `npm install`). |

## 3. Backups

```bash
# full logical export (remote), timestamped:
npx wrangler d1 export telbot-db --remote --output=backups/telbot-db-$(date +%F).sql
```

Include exports in private storage (they contain **PII**: telegram ids, names,
order amounts — treat as confidential, never commit!). Restore: export→
`d1 execute --local` verification copy, or Cloudflare dashboard point-in-time
restore if your plan offers it. Frequency: weekly at minimum + immediately
before every migration apply. No secrets live in D1 (by design), so exports are
safe from that angle.

## 4. Dependency & platform upkeep

- Dependencies: only `typescript`, `wrangler`, `@cloudflare/workers-types`
  (devDeps, zero runtime deps) — periodic `npm outdated` review is enough;
  bump deliberately with the full gate suite.
- Cloudflare platform: watch Worker runtime/D1 deprecation notices;
  `compatibility_date` pin (`2026-09-01`) keeps runtime behavior stable until
  you choose to move it (test thoroughly if/when — cron behavior, D1 batch
  semantics included).
- Telegram Bot API: code uses long-stable methods (sendMessage…getMe) +
  Bot API 8.0 keyboard styles which degrade silently on older clients.

## 5. Change discipline (the repo's own rules, restated)

1. migrations append-only; 2. money/docs changes via their CAS-audited paths
where UI exists; 3. `typecheck+test` green before any git push; 4. bilingual
docs updated in the same change; 5. no secrets, no SQL hand-editing of ledger
tables except researched reconciliations; 6. after deploy: verify `/health`,
`/pending`, one smoke order.

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/maintenance.md)
