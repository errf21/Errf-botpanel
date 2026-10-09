# MraPanel group configuration fix — implementation and test report

## Exact baseline and scope

This update is based on public `master` **fe5cf8cd44cf1f4b8f4c1e8703161c93cd99d803**, 235 tracked files. It preserves the DNS compatibility fix in that revision and the public user's current CHANGES.txt content. It does not replace this tree with an older delivered archive. Baseline execution: **876 passed, 0 failed, 0 skipped**.

## Root cause supported by code

`configuredPanels()` / `groupIds()` in `src/panels/bindings.ts` seed `[]` when an initial Worker declaration omits `PANEL_1_GROUP_IDS`. In the original `src/panels/admin.ts::verifyConfiguration()`, the successful administrator/declared-user-permission checks were followed by `if (!groups.length) return 'groups_missing'`. No group-list request was performed in that branch. Therefore the reported result does not establish that the API key lacks group permission: it identifies an empty local provisioning selection. Viewing groups is not equivalent to choosing them.

This reproduces the reported configuration with synthetic credentials. It is not a claim to have inspected the production D1 row or contacted MraPanel with the production key.

An additional reproduced bug in `PasarGuardClient.#request()` applied strict user-absence certification to every dynamic-panel 404, including group-list/detail endpoints. A real group 404 became a parse/unverified-absence error. The guard now applies only to `/api/user` and `/api/user/...`; the stricter deletion/identity protections for users remain intact.

`syncConfiguredPanels()` already seeded groups only on INSERT and omitted groups from UPDATE. The implementation now documents this invariant and tests it rather than rewriting correct synchronization logic. Missing, empty, malformed, changed environment GROUP_IDS, repeated initialization and credential rotation do not overwrite saved Mini App selections. Rotation still requires the existing re-test/re-enable behavior; it is tested with synthetic secrets only.

## Implemented behavior

- An empty-selection Test performs read-only group discovery after the existing account and declared user-permission checks. It distinguishes HTTP authentication/permission/unsupported-endpoint failures, unexpected responses, empty lists, all-disabled lists and a genuine missing local selection.
- Only successful discovery of enabled groups with no saved selection returns `groups_missing`. It includes Persian/English guidance and an existing authenticated, actor-owned configuration-session Web App button.
- Existing saved IDs are validated as unique positive safe integers (maximum 50, bounded by the existing ID limit). Every selected group is read individually. An exact numeric matching ID and a boolean `is_disabled` are required; unavailable, disabled or malformed selected groups are rejected before saving.
- The visual selector auto-discovers on editing, preselects saved IDs, excludes disabled groups from selection and Select All, warns about unavailable old selections, and submits numeric IDs rather than names. Save errors use controlled localized codes, not raw upstream text. A failed consumed save session requires a fresh form, preserving replay protection.
- Managed-panel forms keep the existing URL locked and API-key input hidden. They update name/groups only, retaining the Worker credential binding. Dynamic panels retain existing encrypted credential storage.
- No groups are invented or automatically chosen; no panel is automatically enabled or selected. Separate panels retain independent origins, key references and selected IDs. Existing provisioning uses each resolved panel's saved IDs; registry/provisioning code was not rewritten.

## Verified upstream contract and limits

Public upstream: `PasarGuard/panel`, tag **v5.4.1**, commit **b56ffe369f542152c52c69733205baeaf3f6e4cd**. Re-fetched public router/model/dependency source hashes match the existing pinned contract evidence; see `docs/evidence/mrapanel-group-contract-verification.json`.

- `app/routers/group.py`: router prefix `/api/group`, GET route `s` => **GET `/api/groups?offset=N&limit=100`**. Response: `{groups: [...], total: integer}`.
- `app/models/group.py`: actual numeric IDs, names, boolean `is_disabled`, and additional fields. Browser responses expose only ID/name and a disabled marker, not inbound/admin details.
- Group-detail endpoint: **GET `/api/group/{id}`**.
- List and detail require **`groups.read`**. `/api/groups/simple` uses **`groups.read_simple`** and is not a substitute for the full-detail permission. No undocumented fallback endpoint was added.
- `app/routers/dependencies/group.py`: offset/limit pagination. Client retains 100/page, up to 10 pages/1000 groups, a 20-second discovery deadline, stable total/duplicate checks and rejection of partial lists. Maximum saved selection remains 50 IDs.
- Existing account status and declared create/read/update/reset/delete user-permission checks remain required. Testing does not prove live user mutations work.

**Not verified:** that the actual MraPanel deployment is this upstream version or an identical fork; its live response schema, configured key permissions, TLS/connectivity and real provisioning. Mocked 5.4.1 responses are not live compatibility evidence.

## Authorization and secrets

`src/panels/security.ts` is byte-identical to the baseline, preserving the fe5cf8c DNS behavior, public-address classification, HTTPS/ports, redirect protection, AES-GCM and fail-closed Telegram authentication.

Private Telegram handlers still require `isPanelAdmin()`: explicit numeric `ADMIN_CHAT_ID` and/or comma-separated `PANEL_ADMIN_IDS`. General database admin status alone does not grant panel access. Every metadata/discovery/configuration endpoint independently validates signed fresh Telegram Web App initData with `TELEGRAM_BOT_TOKEN`, current panel-admin authorization and session ownership. Generic GET shells contain no existing configuration. Origin/content-type checks and revision guards remain; neither links nor Origin prove identity. Discovery does not consume the save nonce; saving atomically consumes it. Used, wrong-owner or changed sessions are rejected.

Managed keys remain Worker secrets; API keys, binding references, ciphertext and encryption keys are not returned in metadata. Discovery returns no credentials; existing reflected-secret group-name rejection remains. Public DNS validation occurs before panel credentials are sent, requests reject redirects, and all newly exercised test operations are GET/read-only. No authorization, encryption, DNS/SSRF, routing or lifecycle safeguard was removed.

## Administrator workflow and configuration

1. In private chat, authorized administrator sends **`/panels`**.
2. Press **`Test MraPanel`**. If discovery succeeds but selection is empty, press **`Choose panel groups`** / **`انتخاب گروه‌های پنل`**. Alternatively use existing **`Edit MraPanel`** and its secure form button.
3. The managed form reads its own saved origin/key server-side. Check one or more enabled actual group names; Select All applies to enabled discovered groups within the existing 50-selection limit.
4. Press **`Test and save securely`** / **`آزمایش و ذخیرهٔ امن`**. Each chosen group is verified again before D1 persistence.
5. Open Edit again to see preselected IDs. Run Test again; a valid configuration reports `ok`.
6. Enable new orders and explicitly Select/confirm MraPanel only when ready. Existing services and assigned orders remain on their original panels.

Keep existing `PANEL_COUNT=1`, `PANEL_1_NAME`, `PANEL_1_URL`, secret `PANEL_1_API_KEY`, legacy bindings and `PANEL_ENCRYPTION_KEY` unchanged. **No `PANEL_1_GROUP_IDS` is required** when using the Mini App. The existing `PANEL_ADMIN_ORIGIN` must equal the bot Worker public HTTPS origin (not the PasarGuard origin); its route must reach this Worker. Existing bot token/admin IDs remain required. No new settings, dependencies or schema changes. Migrations 0001–0025 are unchanged; do not rerun 0025 for this update.

## Actual validation

Commands executed from the final local source:

```sh
npm test
npm run typecheck
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir /data/mrapanel-groups-dry-run
node --disable-warning=ExperimentalWarning --test tests/mrapanelGroups*.test.ts
```

| Check | Actual result |
|---|---|
| Baseline full suite | 876 passed; 0 failures, skips or cancellations |
| Final full suite | 909 passed; 0 failures, skips or cancellations |
| New targeted suite | 33 passed; 0 failures/skips |
| TypeScript | PASS |
| Worker dry-run | PASS; Wrangler 4.131.1; 912.38 KiB / gzip 178.59 KiB |
| Local workerd + D1 group flow | PASS; real runtime/D1, synthetic upstream only |
| Live MraPanel / production Telegram | NOT RUN |
| Production migrations/deployment | NOT RUN |

New coverage: empty env groups; discovery/save/reopen; pagination over 200 IDs; unauthorized/unsigned/wrong-owner requests; one-use saves and replay; two independent managed panels; explicit selection and panel-specific provisioning settings; absent/empty/changed GROUP_IDS synchronization; synthetic key rotation; HTTP 401/403/404/500; empty/disabled/malformed lists; strict group IDs/status; disabled UI choices; Persian/English/RTL diagnostics; cross-panel URL/key substitution rejected. Two old group fixtures were corrected to include the real upstream boolean `is_disabled`; no tests were removed, skipped or weakened.

The runtime test runs actual bundled handlers in installed workerd and local D1, with outbound requests intercepted by an isolated synthetic service. It does not prove real DNS routing or upstream permission behavior. Existing security/identity/financial/migration/announcement tests remain in the full suite. No production DB, secrets or credentials were used.

## Exact changed-file list

1. `src/panels/admin.ts`
2. `src/panels/bindings.ts` (comment only)
3. `src/panels/form.ts`
4. `src/pasarguard/client.ts`
5. `src/telegram/texts.ts`
6. `src/telegram/texts.en.ts`
7. `tests/multiPanel.test.ts` (fixture)
8. `tests/panelAuthorization.test.ts` (fixture)
9. `tests/mrapanelGroupsWorkflow.test.ts` (new)
10. `tests/mrapanelGroupsRuntime.test.ts` (new)
11. `docs/en/mrapanel-group-configuration-fix.md` (new)
12. `docs/evidence/mrapanel-group-contract-verification.json` (new)
13. `CHANGES.txt`

No changes to `src/panels/security.ts`, registry, provisioning, migration engine, financial logic, schema migrations, package/dependency files or Wrangler configuration.

## Readiness and remaining checks

**Ready for controlled deployment validation of this fix**, subject to ordinary review and the live API uncertainty above; not a claim of fully verified production integration. Before selecting MraPanel for purchases, verify the authenticated form on a controlled deployment: discovery displays actual groups, save/reopen preserves selection, Test reports accurate permission results, existing panels retain their IDs/settings, and unauthorized requests remain rejected. Perform any real provisioning only with separate explicit staging authorization; no destructive connectivity test is needed for this group fix.

No production settings, keys (including PANEL_ENCRYPTION_KEY), data, migrations, deployment, commit or push were changed. The repository builds a Cloudflare Worker, not an Android APK.

The accompanying patch is against the exact fe5cf8cd44cf1f4b8f4c1e8703161c93cd99d803 base, not an older vanilla tree. Archive/patch verification is provided separately, including all final-file SHA-256 values and reconstruction checks.
