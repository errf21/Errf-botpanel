# Development — English

🇬🇧 English · [🇮🇷 فارسی](../fa/development.md) · [index](README.md)

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Local setup

```bash
git clone <repo-url> && cd telbotv2
npm install                      # wrangler + typescript only (3 devDeps)
cp .dev.vars.example .dev.vars   # fill LOCAL values (gitignored)
npx wrangler login               # only needed the first time / for real DB
npx wrangler d1 create telbot-db # paste database_id into wrangler.jsonc
npm run db:migrate:local         # applies 0001..0013 to .wrangler local DB
```

## 2. Commands (exact `package.json` scripts — nothing else exists)

| Command | Actual | Notes |
| --- | --- | --- |
| `npm test` | `node --disable-warning=ExperimentalWarning --test tests/*.test.ts` | 22 test files (`helpers.ts` is a shared lib, not a suite); **needs Node ≥ 22.18 / ≥ 23.6** (native TS execution + `node:sqlite`). |
| `npm run typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) | The only static gate — **there is no lint script and no formatter config in this repo**. |
| `npm run dev` | `wrangler dev` (uses `.dev.vars` + local D1; cron does NOT fire) | |
| `npm run deploy` | `wrangler deploy` | |
| `npm run db:create` | `wrangler d1 create telbot-db` | |
| `npm run db:migrate:local` / `:remote` | `wrangler d1 migrations apply telbot-db [--local|--remote]` | |

## 3. Test architecture (`tests/helpers.ts`)

- **D1 shim**: in-memory SQLite via `node:sqlite` (`DatabaseSync`) implementing
  `prepare/bind/all/first/raw/batch` with `meta.changes` — real SQL from `src/db/*`
  executes, including CHECK constraints and partial unique indexes.
- **Telegram stub**: fetch mock recording sent messages/keyboards/callbacks;
  helpers drive full webhook updates (`processTelegramUpdate`).
- Suites: unit tests for the pure layers (`machine.test.ts`, `pricing.test.ts`,
  `pricingDoc.test.ts`, `validate.test.ts`, `i18n.test.ts`, `configname.test.ts`,
  `catalog.test.ts`, guide) + **phase e2e suites (phase2…phase13)** driving whole
  flows end-to-end, cron sweeps via explicit `now`, and byte-for-byte pins on
  established Persian copy.
- No external services, no network, no fixtures directories — deterministic.

Run everything before and after every change (this is the repo's contract):
`npm run typecheck && npm test`.

## 4. Local iteration patterns

```bash
# direct webhook poke (local dev only, with your .dev.vars secret value):
printf '{"update_id":1,"message":{"message_id":1,"from":{"id":111,"is_bot":false,"first_name":"Dev"},"chat":{"id":111},"text":"/start"}}' \
 | curl -sS -X POST http://localhost:8787/telegram/webhook \
   -H "X-Telegram-Bot-Api-Secret-Token: <your local secret>" \
   -H 'content-type: application/json' -d @-

# query the local DB:
npx wrangler d1 execute telbot-db --local --command "SELECT * FROM settings;"
```

(With `npm run dev` running, `POST /telegram/webhook` + a real Update JSON —
as above — is the closest thing to "acting as Telegram"; the phase tests remain
the real harness.) The token in `.dev.vars` should be a TEST bot token if you
want the sends to actually arrive somewhere.

## 5. Development workflow / conventions (what the code style demands)

- **No framework**: plain Worker `fetch`/`scheduled`, explicit routing; handlers
  receive `UpdateContext` (env, db, api, actor, isAdmin, ui…).
- New SQL goes in `src/db/<domain>.ts` as a **single guarded statement**
  (WHERE-state + affected-rows or CAS) — never multi-statement assumptions
  outside `db.batch` for atomic units; side-effects only after a won claim
  (`meta.changes === 1`).
- New config: `src/catalog/<doc>.ts` validate-on-load with versioned
  `{schema}` field + typed error reasons + degrade/fail policy
  (money-adjacent ⇒ **closed**; halt-the-business risk ⇒ **open** like `sales`).
- New callbacks: extend the `CB`/parser vocabulary in `menu.ts`+`validate.ts`
  FIRST (allowlist), then handle; ULID-carrying callbacks need their own
  namespace parser; every action re-checks ownership/admin server-side.
- New copy: fa (`texts.ts`) defines the `Texts` contract; en (`texts.en.ts`)
  MUST compile-mirror it (typecheck enforces) — write English natively, and
  respect the established persona; **customer-visible money strings follow the
  display contract** (final total only).
- Migrations: append-only, `NNNN_name.sql`, additive seeds `INSERT OR IGNORE`,
  CHECK-list rebuilds copy the exact established pattern, deploy-safe
  backfills where live data exists (see 0008/0009), one concern per file.
- Never log secret material or raw user content beyond bounded sanitized
  fields; never log panel details beyond the 200-char stripped slice.

## 6. Safe modification workflow (the project's own discipline)

1. `git switch` from clean `master`; keep phases granular.
2. Add/adjust migrations **without touching** existing ones (schema) — code
   changes must tolerate un-migrated DBs where feasible; where not, order
   matters (migration-BEFORE-deploy — see [deployment](deployment.md)).
3. Typecheck → tests → a local run smoke (`npm run dev`).
4. Update bilingual docs in the SAME change (both `docs/en` + `docs/fa`).
5. Review diffs around: pricing engine, checkout, db guards, webhook auth,
   i18n boundary (`uiFor`), sales gates — the invariants there are the product.
6. PR/commit per phase-style unit of work (repo history shows the pattern:
   `feat: implement phase …`).

## 7. Tooling notes

- TS 5.x, `moduleResolution: bundler`, `.ts` import extensions allowed
  (`allowImportingTsExtensions`), target ES2022 + `@cloudflare/workers-types`,
  `nodejs_compat` flag enabled in `wrangler.jsonc`.
- Wrangler 4: `keep_vars: true` set; compatibility_date pinned.
- Optional but not required by the repo: editor with ESLint/Prettier locally —
  **do not add config files to the repo just because** (none exist today; a docs
  pass must not introduce tooling drift).

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/development.md)
