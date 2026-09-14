# TELBOTV2 Documentation — English

🇬🇧 **English** · [🇮🇷 فارسی](../fa/README.md)

Full technical documentation for **TELBOTV2**, a production Telegram VPN sales
bot on Cloudflare Workers + D1, with PasarGuard provisioning and intentionally
manual (admin-reviewed) card payments.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## Start here

| Page | Answers |
| --- | --- |
| [Setup](setup.md) | Requirements and the zero→running path (incl. production checklist) |
| [Configuration](configuration.md) | Every env var, secret, and D1 settings document |
| [Architecture](architecture.md) | Components, data flow, and the source map |
| [Database & migrations](database.md) | D1 schema, all 13 migrations, safe procedure |
| [Telegram](telegram.md) | BotFather, token, webhook registration/verification |
| [PasarGuard](pasarguard.md) | Exact endpoints, payloads, failure semantics |

## Product & operations

| Page | Answers |
| --- | --- |
| [Features](features.md) | Everything actually implemented (nothing imagined) |
| [Pricing & sales stop](pricing.md) | Price model, `/pricing`, `/sales`, snapshots |
| [Payment, wallet & referral](payment-wallet.md) | Receipt review, reminders, ledger, payouts |
| [Admin guide](admin.md) | Commands, queues, workflows, D1 config edits |
| [Customer guide](customer-guide.md) | Each customer-facing screen |
| [Localization](localization.md) | Persian/English behavior and rules |

## Engineering

| Page | Answers |
| --- | --- |
| [Security](security.md) | Secrets, auth, CAS, fail-open/closed matrix |
| [Development](development.md) | Local dev, tests, typecheck, workflow |
| [Deployment & updates](deployment.md) | Go-live, migrate-before-deploy, rollback |
| [Troubleshooting](troubleshooting.md) | Symptoms → causes → fixes |
| [Maintenance](maintenance.md) | Routine checks, rotation, backups |

---

## Reading rules

- Technical identifiers — commands, env names, file paths, SQL, callback
  values — are **never translated**; they are exactly as in code.
- Every statement in these pages is traceable to a file in this repository
  (paths given inline). If a fact cannot be derived from the repo (e.g.
  whether a production D1 exists), it is explicitly marked **"not
  determinable from the repository"** rather than guessed.
- Secrets are never shown. All examples use obvious placeholders
  (`<...>` or empty values).

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/README.md)
