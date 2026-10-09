# Targeted Mini App authorization fixes — delivery report

## Baseline and scope

Used the exact local implementation audited in the preceding authorization audit.
Its pre-edit project-file fingerprint was:
`f2bc72b2379970f1e1a8c3adc4d170635f0cb4c328758e767412a6e4bba7a651`.
The original GitHub base remains commit `348c2414dbae119b962076fed9223d3edc29970b`;
the delivered multi-panel changes have not been committed or pushed.

This is an incremental security correction, not a rebuild or multi-panel rewrite.
No deployments, commits, pushes, production secret/configuration changes, or
production migrations/data operations occurred. No real panel credentials or
live Telegram/PasarGuard access were used.

## Finding 1 fix: unauthenticated GET metadata exposure

`src/panels/admin.ts:panelAdminRoute()` now serves a generic shell for
`GET /admin/panels?nonce=...`. It performs no registry/session lookup and embeds
no existing name, panel origin, groups, credential-state flag, API key or ciphertext.
A nonce/link is never interpreted as the viewer's identity.

NEW `POST /admin/panels/metadata` uses the same server authentication boundary as
configuration: expected HTTPS endpoint/Origin, bounded JSON request, fresh signed
Telegram initData, current numeric administrator allowlist, and actor-bound
configure-session lookup with expiry. It also checks the panel revision.
The response is an explicit DTO containing only:
`name`, `url`, `groups`, `legacy`, `hasApiKey`.
No API key, ciphertext, bot token, master secret or environment binding is serialized.

The Mini App fetches this endpoint before prefilling/enabling its fields. Failed
or unauthorized loading leaves fields hidden/disabled. Values are assigned through
DOM value/textContent properties. Legacy editing remains name-only; blank-key
retention and normal dynamic-panel add/edit behavior remain intact.

Metadata reads do not consume the configure nonce: the authenticated read is
repeatable during the session, while the subsequent write remains one-use.
After write consumption, further metadata/configure requests are rejected.

`src/index.ts` adds only routing for the new metadata endpoint. If an external
reverse proxy/WAF restricts paths, the operator must allow this POST path while
retaining its server authentication; no deployment configuration was changed here.

## Finding 2 fix: missing bot token fail-open

`src/panels/security.ts:verifyInitData()` rejects a missing, non-string, empty or
whitespace-only `TELEGRAM_BOT_TOKEN` BEFORE reading/parsing initData or deriving
HMAC material. A valid configured token is used unchanged, preserving normal
signature behavior. There is no fallback/empty-token derivation.

Both sensitive Mini App POST endpoints call this verifier and return 403 for the
reproduced forged administrator requests when the token is unavailable. Neither
nonce possession nor an Origin header can bypass this authentication check.
The generic GET shell contains no protected metadata and is intentionally public.

Existing ADMIN_CHAT_ID/PANEL_ADMIN_IDS checks, actor binding, five-minute session
expiry, fresh signatures, atomic nonce consumption and configuration CAS remain.

## Changed files against the audited baseline

| File | Change |
| --- | --- |
| `src/panels/admin.ts` | Generic shell, authenticated metadata DTO, frontend authenticated loading |
| `src/panels/security.ts` | Required bot-token guard before HMAC processing |
| `src/index.ts` | Register metadata route |
| `tests/panelAuthorization.test.ts` | 15 permanent security/workflow regression tests |
| `AUTHORIZATION_FIX_REPORT.md` | This handoff and validation record |

All other project files match the audited baseline byte-for-byte, including
migrations 0020/0021, API-key encryption/storage, panel selection/ownership,
payments, wallets, customers, orders, services, referrals, pricing, notifications,
package manifests/lockfile and Wrangler configuration.
No new migration, secret, variable, dependency or per-panel setup is required.

## Permanent regression coverage

- Valid borrowed form URL returns generic HTML, not existing configuration.
- Direct GET to metadata does not return configuration.
- Signed ordinary users and database-only admins cannot read metadata.
- Signed allowlisted session owner receives only the non-secret edit DTO.
- Unsigned/forged/altered/stale/future/duplicate-field initData is rejected.
- Another allowlisted administrator cannot borrow the first's session.
- Missing/expired/wrong-action sessions and stale revisions are rejected.
- Current allowlist revocation/complete empty allowlist denies sensitive requests.
- Wrong Origin/endpoint/content-type gates and spoofed Origin do not authenticate.
- Missing, empty, space-only and tab/newline-only bot tokens fail verification.
- The previously reproduced forged-HMAC attack fails on BOTH sensitive endpoints
  with otherwise valid, outstanding administrator sessions; no state changes or
  nonce consumption occur.
- Correct signatures preserve add/edit, hidden keys and encrypted storage.
- Authenticated metadata does not consume the write nonce.
- Concurrent duplicate submissions produce exactly one update/audit record;
  write replay and subsequent metadata access are rejected.
- The emitted frontend script loads authenticated metadata before enabling the
  form, submits correctly, and never prefills stored keys. An unauthorized
  borrowed-link frontend remains hidden/disabled.

Frontend tests execute the actual emitted script with a synthetic DOM and mocked
Telegram initData against the actual Worker routes. They are NOT a live Telegram
client/browser security certification.

## Validation actually executed

| Check | Actual result |
| --- | --- |
| Targeted authorization suite | 15/15 passed |
| Full `npm test` suite | 516/516 passed; 0 failed/skipped |
| `npm run typecheck` | Passed |
| Wrangler `deploy --dry-run` | Passed; 747.63 KiB / gzip 143.71 KiB; NOT deployed |
| `git diff --check` | Passed |
| Non-target project-file byte comparison | Passed |

No lint configuration exists; no lint pass is claimed. No production or live
compatibility results are claimed. No new database migration was needed/applied.

## Delivery

- `errf-botpanel-authorization-fixed.zip`: complete updated source, docs, tests and
  existing migrations; excludes .git, dependencies, local D1 state, builds and
  private credential files.
- `errf-authorization-fixes.patch`: incremental patch against the exact audited
  API-key multi-panel delivery (NOT against the original unmodified GitHub code).

Use the matching audited baseline for the patch. Review with `git apply --check`
before applying over other local changes. This report supersedes prior test counts
and authorization statements; the broader implementation report is unchanged.

Both reproduced vulnerabilities are blocked by local tests. Real Telegram-client
behavior, live panel compatibility, deployed configuration and production security
remain unverified. Production/staging deployment awaits explicit authorization.
