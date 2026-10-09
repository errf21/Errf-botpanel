# Migration localization and 5.4.1 group integration — implementation/test report

## Exact baseline

The source was verified byte-for-byte against the delivered `Errf-botpanel-visual-group-selector.zip`: **219 files**, SHA-256 `033003e10507753d32319216af75c9cdc6922d140cf10bf348bef988a830018e`. Its previous executed full suite had **704 passing tests**. A separate immutable copy was preserved before edits. Git HEAD remains `348c2414dbae119b962076fed9223d3edc29970b`; that commit is NOT a substitute for this accumulated local baseline. No vanilla GitHub checkout was used.

## Actual changes

1. `src/handlers/serviceMigration.ts` now uses the existing shared `Ui`/`Texts` dictionaries for help, customer/service selection, destination pagination, review/evidence, stages, errors, confirmation, retries, abort, revocation, progress and callback responses. Machine error codes remain durable internal diagnostics; user-facing reasons are localized and unknown exceptions are redacted.
2. `src/telegram/texts.ts` / `texts.en.ts` contain matching migration translations under the existing structural `Texts` contract. Commands remain technical commands; surrounding help and placeholders are localized. IDs, URLs, usernames and technical values are bidi-isolated for Persian. Existing ASCII digit policy and UTC formatting are preserved. No new language selector/detection system exists.
3. Customer handoff queries the recipient's persisted `customers.language` and uses `uiFor()` both in immediate delivery and scheduled retries. The administrator's language and Telegram's language hint do not override customer preference. The confirmed-success delivery stamp and recovery semantics are unchanged.
4. `src/migrations/service.ts` verifies the captured destination's groups before opening a draft and before progression. It rejects empty/duplicate/invalid IDs, unreadable/missing/malformed/disabled group resources and destination read-back with different IDs. The exact saved numeric group IDs are sent in creation. Editing defaults after review does not silently substitute new groups. The review card explicitly states this snapshot policy and absence of a per-migration override.
5. Group validation has a 30-second checked budget; `PasarGuardClient.getGroup()` accepts an optional timeout while preserving its prior default for existing callers. A final in-flight request can complete just beyond the budget due to existing DNS validation, but expired validation cannot lead to creation/activation. This keeps the new validation work bounded relative to the existing service lease.
6. `src/pasarguard/client.ts` parses `UserResponse.group_ids` strictly; missing/malformed/duplicate/empty IDs remain unverified. UserCreate/read-back now has explicit group identity verification for migration. Existing API-key headers, URL safeguards, stable-ID operations and absence checks are unchanged.
7. `src/panels/admin.ts` rejects an explicitly disabled selected group during the existing final configuration verification. AES-GCM, encryption AAD, nonce/session/allowlist/metadata protections and the visual form itself remain unchanged.
8. `docs/evidence/pasarguard-5.4.1-contract.json` records the resolved official tag commit, inspected source URLs/hashes and explicitly synthetic contract examples. `tests/pasarguard541.test.ts` tests those formats and actual client endpoint/header behavior with mocks.

No money, pricing, entitlement formula, original expiry rule, device-limit rule, source deletion confirmation, active-resource overlay, migration state schema or unrelated business workflow was rewritten.

## Regression additions and retained behavior

**34 new tests**: 25 migration tests, 2 visual-selector integration tests and 7 version-pinned parser/client contract tests. All previous tests remain present and enabled.

New coverage includes both administrator locales throughout help/review/callback activation/revocation, distinct fresh/stale/manual labels, localized authorization/validation/recovery errors, localized aborts, recipient-language scheduled handoff and Persian default despite an English Telegram hint. Group coverage includes actual selector save → immutable migration config → destination create/read-back → activation; exact bytes/absolute expiry/device limit; changed panel defaults; missing/disabled/permission/malformed groups; mismatched remote IDs; deletion after staging; safe retry; and validation deadline failure without source loss.

Existing coverage retained: changed fresh entitlement at confirmation, invalid/exhausted/unlimited/unsupported plans, unknown create/delete outcomes, duplicate confirmations/concurrent runners, worker interruption checkpoints, identity/customer isolation, stable-ID deletion, scoped/proxy 404 rejection, financial/history preservation, source-unavailable saved/manual flows, no fallback, locks, abort fencing, URL rotation and blocked recovery.

Three existing backoff tests were rearranged to make the destination fail AFTER a successfully validated draft, because the new pre-draft group gate correctly rejects an already-unavailable destination. Their backoff/fairness/recovery assertions were preserved. The group HTTP fixture now supplies the 5.4.1 `is_disabled` field. No test was deleted, skipped, or weakened to get a passing result.

## Commands executed and final results

| Check | Command / method | Actual result |
|---|---|---|
| TypeScript | `npm run typecheck` | PASS; exit 0 |
| Complete suite | `npm test` → `node --disable-warning=ExperimentalWarning --test tests/*.test.ts` | **738 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**; final run 39,857.557 ms |
| Targeted set | `node --disable-warning=ExperimentalWarning --test tests/serviceMigration.test.ts tests/serviceMigrationSchema.test.ts tests/panelGroups.test.ts tests/pasarguard541.test.ts` | **126 passed, 0 failed/cancelled/skipped/todo**; 8,235.196 ms |
| Worker build | `node node_modules/wrangler/bin/wrangler.js deploy --dry-run` | PASS; Wrangler 4.131.1; 882.98 KiB / 172.37 KiB gzip; no deployment |
| Isolated schema | Python SQLite in-memory, `PRAGMA foreign_keys=ON`, each existing migration executed inside BEGIN/COMMIT | 0001–0024 applied; **29 application tables; zero foreign-key violations** |
| Existing schema tests | Included in full/targeted suites | Seeded preservation, FK checks and transactional rollback/repeat-failure regressions pass |
| Archive | Complete source whitelist, ZIP CRC check and byte comparison against every final file | Verified during packaging |

A preliminary Python autocommit replay failed foreign-key enforcement; rerunning with the required per-file transactions passed. Released migrations are unchanged and already require transactional execution. Use Wrangler's version tracking/transactions, not raw autocommit replay. No production migration or database was involved.

Intermediate complete runs also passed 735 and 737 tests before the final callback/deadline additions. The final release result is 738, not an unexecuted estimate. TypeScript and dry-run were repeated after the final code change.

## Compatibility evidence — what it proves

The official public tag `v5.4.1` resolves to `b56ffe369f542152c52c69733205baeaf3f6e4cd`. Inspected `app/routers/group.py`, `app/models/group.py`, `app/routers/dependencies/group.py`, `app/routers/user.py`, `app/models/user.py` and `app/routers/authentication.py` support the endpoint/header/schema/permission descriptions in the validation guide. Fixtures use numeric IDs, boolean is_disabled, numeric quota/usage/hwid and ISO expiry.

This proves correspondence with inspected versioned source plus local client behavior. It does NOT prove that the user's installation runs an unmodified 5.4.1, that its API key has adequate scopes, that its groups/inbounds work, or that a live subscription can connect.

## Test environment and remaining verification

PasarGuard, Telegram and DNS HTTP interactions were mocked. Local database assertions use real SQLite/D1 shim synthetic fixtures, not production exports or live Cloudflare D1. Concurrent async tests exercise the implemented claims/constraints but are not proof of distributed production timing. No staging server was used, no real user was created/deleted, and no actual customer notification was sent.

Still required after separate approval: actual panel version/OpenAPI and scopes, live disposable migration, old/new subscription connectivity, node-side deletion propagation, Telegram RTL/URL usability, realistic Worker subrequest/time limits, Cron recovery and distributed D1 interruption/concurrency behavior. Snapshot consumption overlap and stale/manual uncertainty remain inherent disclosed limitations, not silently solved by mocked tests.

The visual selector's markup/CSS and the existing authorization security module are byte-identical to the starting release. Its permanent interaction/security tests ran in the complete suite; this phase did not perform a fresh real-browser or live Telegram Mini App session.

## Release safety and artifacts

No new migration, dependency, environment variable, Worker secret or Cloudflare product. `PANEL_ENCRYPTION_KEY` was not rotated/replaced, and all existing encrypted credentials remain under the existing mechanism. Previous financial, announcement, dedupe, multi-panel and migration recovery tests remain passing. No production data/secrets/configuration changes, deployment, commit, push or release publication.

Deliverables: complete final source ZIP, current CHANGES.txt, this test report, and `docs/en/migration-localization-validation.md` with exact staging procedures. The ZIP contains the accumulated implementation, not vanilla HEAD. Existing migration files 0001–0024 and unchanged business/security files were compared to the exact starting archive during packaging.
