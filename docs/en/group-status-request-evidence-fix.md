# Group-status resolution and Cloudflare request evidence — implementation report

## Exact baseline

Latest public master was **56e4c0b0ee83bff3bcfbd80010a69270f0ea8ecb**, 243 tracked files. The referenced local commit 4b8508de72e4a8f7cda0b8a5efd949ba82c3ff6d is not an ancestor in that public history; **all public src files match its delivered source byte-for-byte**. Work started from actual latest public master, preserving its existing files rather than resetting it to an older hash. Baseline suite actually passed 967 tests, zero failures/skips/cancellations.

## What is confirmed and what is not

Confirmed from code: Telegram Test with an empty saved group selection runs account checks and list discovery. If the simple response contains IDs/names but no status, it returns `groups_status_unverified` **without requesting any group-detail endpoint**. Therefore that result alone is not evidence that GET `/api/group/{id}` failed. A checkbox selection in an unsaved form is not yet a saved group assignment.

The selected-group action is a separate authenticated Worker request. Previously it discarded exact HTTP/path evidence into broad error codes and used only detail reads, even where an authorized full-list status response might be available. Save used a separate detail-only verification path. These implementation gaps are fixed.

**Not confirmed:** the real failing selected-group request's HTTP status/body, actual MraPanel fork/version, effective key scope or reverse-proxy rules. No live credential was requested; no production API or Cloudflare resource was accessed. A 403 proves denial of that request, but by itself cannot distinguish panel RBAC from a proxy policy. The new action exposes the exact safe evidence needed for that distinction without guessing.

## Official source contracts

Public upstream PasarGuard/panel v5.4.1, pinned commit **b56ffe369f542152c52c69733205baeaf3f6e4cd**. Nine source files were freshly fetched and hashed in `docs/evidence/group-status-request-contract-541.json`.

| Read-only endpoint | Required upstream action | Response evidence |
|---|---|---|
| GET `/api/group/{id}` | `groups.read` | Exact numeric id, boolean `is_disabled` |
| GET `/api/groups?offset=N&limit=100` | `groups.read` | Full group rows, including explicit `is_disabled` |
| GET `/api/groups/simple?offset=N&limit=100` | `groups.read_simple` | id/name only; no group-status proof |
| User-template read/simple endpoints | `templates.read` / `templates.read_simple` | Template state/IDs; not referenced groups' enabled status |

Evidence: group router/models/dependencies, user-template router/model, authentication/admin-role models, group operation/CRUD source. Simple CRUD selects group ID/name only and does not certify enabled state. Full/detail routes share group-read authorization in inspected v5.4.1. The API-key header is documented `X-Api-Key`; lowercase `x-api-key` is HTTP-equivalent. Method and paths are official, not fabricated. API status does not come from names, group-list appearance or template status.

**Given only the three reported effective actions**, no inspected authorized endpoint exposes group status. A full read denied to the existing principal cannot be made authorized by a new Cloudflare variable. This conclusion is scoped to inspected v5.4.1, not a claim that every MraPanel fork has identical routes/roles.

## Implemented actual status resolver

`src/pasarguard/client.ts::verifyGroupStatuses()`:

1. Validates 1–50 distinct positive safe numeric IDs (existing upper ID bound).
2. Sends GET `/api/group/{id}` to the exact validated panel origin with that panel's existing key.
3. Requires exact ID plus boolean `is_disabled`; wrong IDs, missing/string status or malformed responses fail closed.
4. Only on detail 403 or 404, attempts the documented **full** group list. It never uses simple or template data as status proof and never changes panels.
5. Full fallback requires explicit boolean status on every parsed row, complete bounded pagination, stable totals and no duplicate IDs. Every requested ID must be present. A partial prefix or another group's status cannot authorize success.
6. Uses one shared 20-second deadline, sequential bounded requests, at most the existing 10 full-list pages/1000 records. Platform request limits still apply; timeout fails safely.
7. Returns no partial successful selection. Both full-status routes denied => permission failure with actual request evidence. Detail 404 plus authorized-list absence => not found/not visible, not proof of service deletion. Both routes 404 => API availability diagnostic.

No alternative request is attempted for authentication failure, malformed identity/schema, network timeout, unsafe destination or unrelated server failure. Full-list access is independently authorized by the upstream API; this is not a permission bypass. Full/status parsing is strict without weakening the existing discovery contract.

Configuration Test and Save now use this same resolver so a validated authoritative full-list status proof is not then rejected by a detail-only save path. Save still performs fresh verification, consumes its owned nonce once and persists only explicit selected numeric IDs. Status previews do not persist configuration or enable/select panels. Disabled groups remain blocked.

Migration engine is unchanged and remains more restrictive: it still checks detail resources at its guarded stages. A full-list-only configuration does not silently make migration authorized. Financial/provisioning/identity/routing code is unchanged.

## Exact request/error evidence

The authenticated selected-group action requests `diagnostics:true` on existing POST `/admin/panels/groups`. Backward-compatible callers that do not request diagnostics retain the existing code-only error response. Already-required signed/fresh initData, current admin allowlist, owner nonce, origin/key binding, revisions and post-request session checks still apply.

A diagnostic contains **only** controlled category/reason, observed HTTP status and attempts such as:

```json
{
  "code": "group_details_permission_denied",
  "diagnostic": {
    "category": "permission",
    "reason": "status_read_denied",
    "httpStatus": 403,
    "attempts": [
      {"method":"GET","endpoint":"/api/group/17","httpStatus":403,"category":"permission"},
      {"method":"GET","endpoint":"/api/groups?offset=0&limit=100","httpStatus":403,"category":"permission"}
    ]
  }
}
```

**This is a regression fixture, not a live MraPanel result.** 17 is a synthetic actual selected numeric ID, not an invented production ID for the displayed name “group 1”. Runtime requests show the actual selected ID.

The API client now preserves real HTTP status for malformed/empty 2xx GETs. No-response timeout/network failures have null HTTP status. GET-body timeout after headers retains received HTTP status with category timeout. Successful POST/PUT/DELETE unknown-outcome semantics are deliberately unchanged, avoiding unsafe mutation retries.

No raw upstream body, secret, credential binding, ciphertext or full host URL is returned. The form whitelists diagnostic path/HTTP/category fields and uses textContent, not HTML. Per-request evidence is rendered separately from translated guidance, in LTR technical text for Persian/English. Ordinary/unsigned users cannot retrieve it. No new plaintext diagnostic history is stored in D1.

## Cloudflare configuration audit

### Actual code path

`src/index.ts::fetch` → `panelAdminRoute()` → signed owned-session validation → `resolvePanel/configuredCredential` → same PanelConfig baseUrl/key → `PasarGuardClient.#request`.

Both working simple-list and selected-status reads use the same resolved origin and key. They differ in **path and required upstream authorization/response fields**, not in a different secret convention or API-prefix construction.

| Item | Exact existing setting / behavior | Result |
|---|---|---|
| Indexed panel declaration | plain `PANEL_COUNT="1"` | Explicit indexing; no arbitrary env enumeration |
| MraPanel URL | plain `PANEL_1_URL`; public HTTPS URL, port 443/8000 | Dashboard input normalized to origin |
| Name | optional plain `PANEL_1_NAME` | Display only; never used as resource ID |
| Credential | Worker secret `PANEL_1_API_KEY` | Both requests use same `x-api-key` value |
| Group IDs | optional `PANEL_1_GROUP_IDS`; numeric JSON array for initial seed | Not required for Mini App selection; synchronization does not overwrite saved groups |
| Bot identity | existing secret `TELEGRAM_BOT_TOKEN` | Nonempty required for initData and binding fingerprint; missing fails before panel I/O |
| Bot webhook | existing secret `TELEGRAM_WEBHOOK_SECRET` | Used for Telegram webhook, not a replacement for panel permissions |
| Panel administrators | plain explicit numeric `ADMIN_CHAT_ID` and/or comma-separated `PANEL_ADMIN_IDS` | Missing allowlist fails closed |
| Secure form origin | plain `PANEL_ADMIN_ORIGIN` | Must be the exact public bot Worker HTTPS origin, not PasarGuard origin |
| Encryption | existing secret `PANEL_ENCRYPTION_KEY` | Preserve unchanged; AES-GCM key for encrypted dynamic panels, not a group-read permission |
| Database | existing D1 binding `DB` | Existing registry/session/selection records |
| Legacy panel | existing `PASARGUARD_PANEL_URL`, secret `PASARGUARD_API_KEY` | Preserved; not used as fallback for MraPanel |

`src/types.ts`, `src/panels/bindings.ts` and `wrangler.jsonc` were inspected. Indexed names are deliberately loaded by validated runtime binding names; they need not each be a literal TypeScript property. `keep_vars:true` preserves externally managed bindings. Existing explicit vars in Wrangler, including ADMIN_CHAT_ID, can be reapplied on deployment; preserve correct existing values during any separately authorized release. No configuration file was changed.

For the given dashboard URL, normalization produces `https://panel.mrapanel.shop:8000`. Paths appended by the shared client are `/api/groups/simple?...` and `/api/group/<numeric-id>`—not `/api/api/...`, `/dashboard/api/...` or a missing-prefix path. Regression tests execute the real Worker dispatcher with this port/capitalization/dashboard input and verify exact requests/headers/numeric IDs. Missing managed key is reported as a pre-request configuration error with **zero** upstream calls, not `groups_status_unverified`.

**No proven configuration change is necessary.** If a required existing binding is actually absent, its exact name/location above identifies it: Cloudflare dashboard → Workers & Pages → existing Worker → Settings → Variables and Secrets; DB remains the existing D1 binding. Do not introduce another key or rotate PANEL_ENCRYPTION_KEY. Production binding values were not inspected and are not inferred from a local template.

### Deployed version

Public repository revision is verified, but the Cloudflare deployment version is **NOT VERIFIED**: no actual Worker origin, deployment record or authorized account connection is available. A GitHub commit/build or user statement does not establish which Worker serves a form URL.

New public, non-secret markers on the generic form/response:

- Header `x-errf-group-status-ui: status-evidence-v1`
- HTML meta `errf-group-status-version` with content `status-evidence-v1`

The existing cloudflare-bindings-v1 markers are preserved. These identify this form/diagnostic feature after an explicitly approved deployment, not live API success or a cryptographic deployment commit hash. Generic unauthenticated shells still contain no existing panel configuration. No production endpoint was queried.

## Actual tests

Commands executed:

```sh
npm test
npm run typecheck
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir /data/status-evidence-dry-run
node --disable-warning=ExperimentalWarning --test tests/groupStatusEvidence.test.ts tests/groupStatusEvidenceRuntime.test.ts
```

| Check | Result |
|---|---|
| Exact current baseline | 967 passed; zero failures/skips/cancellations |
| Final complete suite | **991 passed; zero failures/skips/cancellations** |
| New Worker/runtime tests | 24 passed; zero failures/skips |
| TypeScript | PASS |
| Worker dry-run | PASS |
| Real local workerd/D1 denial evidence | PASS, synthetic read-only upstream |
| Live MraPanel key/API/group status | NOT VERIFIED |
| Live Cloudflare configuration/version | NOT VERIFIED |

Coverage: exact detail/full HTTP evidence; successful authoritative full fallback; disabled groups; missing/string status; wrong IDs; true list absence versus route 404; pagination past 200 groups; auth/server errors without fallback; pre-response and body timeouts; retained malformed HTTP 200; correct Cloudflare base/path construction; missing secret classification; numeric selection transfer; FA/EN evidence rendering; no leaked key; version markers; unauthorized evidence rejection; and preservation of existing workflows. Tests run actual `src/index.ts` dispatcher/routes/client, not only a helper. The runtime test runs installed workerd/local D1 with synthetic responses; it proves neither production DNS/TLS nor live role behavior.

Existing tests are retained. Fixtures for total group-read denial now deny BOTH authoritative routes, rather than modeling detail denial with an independently still-authorized full list. The 404 tests distinguish full-list visible absence from fallback authorization denial. Old code-only error contracts are preserved unless diagnostic evidence is explicitly requested. No assertions or safety tests were removed/skipped.

## Exact changed files

- `src/pasarguard/client.ts`
- `src/panels/admin.ts`
- `src/panels/form.ts`
- `src/telegram/texts.ts`
- `src/telegram/texts.en.ts`
- `tests/groupStatusVerification.test.ts`
- `tests/mrapanelGroupsWorkflow.test.ts`
- `tests/groupStatusEvidence.test.ts` (new)
- `tests/groupStatusEvidenceRuntime.test.ts` (new)
- `docs/evidence/group-status-request-contract-541.json` (new)
- `docs/en/group-status-request-evidence-fix.md` (new)
- `docs/en/mrapanel-group-configuration-fix.md` (current report reference)
- `CHANGES.txt`

No index/dispatch, binding synchronization, credential security, registry, financial, provisioning, migration-engine, schema, dependency or Wrangler configuration change. Previous DNS/authentication/encryption fixes and saved identities/selections are preserved.

## Legitimate next step and release boundary

In the updated source: `/panels` → Edit/review MraPanel → select actual group → Verify selected group status. The form reports actual GET paths, HTTP statuses and categories. An authorized explicit status response permits the existing fresh rechecked Save; denied/missing/malformed/timed-out status keeps saving blocked. No automatic panel switch or migration occurs.

If both official full-status reads return 403, send only this sanitized request evidence to the panel maintainer. The required upstream capability is approved read-only access returning permitted group ID plus boolean is_disabled for the existing principal. The maintainer must review actual supported version/API authorization/role inheritance, not a fictional bot variable or nonexistent UI toggle. No replacement key is required by this report. If both routes are unavailable or return malformed responses, the recorded status/category identifies that separate API contract issue. A 403 alone does not prove whether a proxy or panel RBAC produced it.

The implementation and isolated verification are complete. **Live success and deployed-code identity remain unverified.** No deployment, production setting/secret/data change or production migration was performed. Local commit/push and source ZIP/patch reconstruction evidence are recorded in the artifact verification file/final response. No new resource, dependency, migration or secret is required.

## Safe source integration

The full ZIP is a complete source archive rooted at Errf-botpanel; extract it into a separate empty directory for review, not blindly over a working tree containing unrelated edits. The accompanying unified patch is the change-only integration path, verified against exact base 56e4c0b0ee83bff3bcfbd80010a69270f0ea8ecb. From that clean base, `git apply --check <patch>` must succeed before applying. If the target has newer/conflicting edits, stop and merge the patch deliberately; do not overwrite or reset those edits. Non-overlapping changes outside the patch remain untouched. No automated production deployment or migration is part of integration.
