# Visual panel group selector

This update replaces manual comma-separated Group IDs in the dynamic API-key panel configuration form. It does not change customer, order, payment, wallet, migration, or service routing rules.

## Administrator workflow

1. Open `/panels` in a private Telegram chat as an explicitly authorized panel administrator.
2. Choose **Add** or **Edit**. The secure Mini App opens in the bot's selected English or Persian language; Persian uses RTL layout.
3. For a new panel, enter its display name, public HTTPS origin, and API key in this secure form, never in chat. Group discovery runs after completing the connection fields; **Load groups** also starts discovery explicitly.
4. For an existing dynamic panel, leave the API key blank to keep its encrypted stored key. Groups load automatically and available configured IDs are preselected.
5. Select checkbox rows by their actual names, or use **Select all**. The checkbox becomes indeterminate when only some groups are selected. The count reflects the current selection.
6. **Test and save securely** remains disabled until discovery succeeds and 1–50 available groups are selected. Final server-side validation rechecks the account's required user-operation permissions and each selected group before saving its actual numeric ID.
7. Return to `/panels`; enabling and default selection remain explicit separate actions.

Empty, unavailable, incompatible, rejected-key, and permission-denied responses do not substitute guessed IDs. Use **Retry** after correcting connectivity or permissions. A missing previously configured group is not silently selected; review the warning and choices. Changing the URL/key invalidates discovery, and a delayed response from an older request cannot enable saving.

### Compatibility and limits

- The original `legacy` panel remains name-only in this form. Its existing Worker URL, API key, and group configuration stay untouched; this release intentionally does not move legacy credentials into D1 or change legacy provisioning.
- Existing historical-service URL-edit restrictions remain enforced. Add a separate panel instead of changing an origin with associated services/orders.
- Retaining a stored API key is allowed only for its exact stored origin. An editable, unused panel moved to another origin needs an explicitly entered API key; the original key is not forwarded to that host.
- Discovery is bounded to 1,000 groups, ten pages of at most 100 groups, and a 20-second request deadline (each API call remains bounded by the existing 15-second timeout). Oversized, incomplete, duplicate, or inconsistent lists fail closed, never returning a partial success.
- The existing 50-selected-group configuration limit is unchanged. Select all really selects every discovered group, including lists exceeding 50; saving is then blocked with an explicit limit message. Deselect groups to reach the existing supported limit.
- Connection responses are snapshots, not continuous health monitoring. Unsupported panel versions show an incompatibility error; no alternate endpoint or cross-panel fallback is attempted.

## Verified upstream API

The inspected public PasarGuard source is pinned to commit `b56ffe369f542152c52c69733205baeaf3f6e4cd`:

- Router: https://github.com/PasarGuard/panel/blob/b56ffe369f542152c52c69733205baeaf3f6e4cd/app/routers/group.py
- Response model: https://github.com/PasarGuard/panel/blob/b56ffe369f542152c52c69733205baeaf3f6e4cd/app/models/group.py
- Permissions: https://github.com/PasarGuard/panel/blob/b56ffe369f542152c52c69733205baeaf3f6e4cd/app/routers/dependencies/group.py

The route prefix `/api/group` and GET suffix `s` produce **GET `/api/groups`**, with `offset`/`limit` pagination and a `{groups, total}` response. Discovery requires the API-key account's **groups.read** permission, matching the existing individual group verification requirement. The browser receives only numeric `id` and actual `name`, not inbound details or upstream account metadata.

These findings apply to the inspected source, not an authenticated test of the user's live panel. Live version, permission grants, group configuration, and network connectivity must be checked in staging. This implementation uses the existing API-key client conventions, not username/password login or token acquisition.

## Security and configuration

No new secret, variable, database migration, dependency, or Cloudflare resource is introduced. Preserve the existing `TELEGRAM_BOT_TOKEN`, explicit panel administrator allowlist configuration, `PANEL_ADMIN_ORIGIN`, `PANEL_ENCRYPTION_KEY`, D1 binding, legacy panel settings, and prior migration/configuration requirements.

`POST /admin/panels/groups` uses the existing server-side protections: fresh signed Telegram Web App initData, current authorized administrator IDs, actor-owned unexpired configure session, expected origin, bounded JSON input, and revision checks. Discovery reads do not consume the one-time save nonce; final configuration still consumes it. The public GET remains a generic shell with no existing panel metadata. Stored keys are decrypted only on the Worker and are never included in discovery/metadata responses. API calls retain public HTTPS destination validation, DNS checks, redirect rejection, and redacted errors. Reflected credential values in malicious group names are rejected.

Existing encrypted storage and final account/group verification remain mandatory. The browser necessarily holds a newly typed key until the secure request; stored keys are never returned to it. Group names are inserted as text, not HTML. Discovery does not create or mutate remote users.

## Local validation

Executed against the exact latest local financial-optimization source, not vanilla GitHub HEAD:

- Baseline: 214 files, 680 passing tests.
- Final: 704 passing tests, zero failures/cancellations/skips/todos.
- `npm run typecheck`: passed.
- `node node_modules/wrangler/bin/wrangler.js deploy --dry-run`: passed; no deployment performed.
- Isolated real Chromium: English/Persian mobile interactions, Select all/indeterminate/count behavior, no horizontal overflow or JavaScript errors; loading/empty/error/permission states block saving. Desktop, RTL viewport, and dark-mode screenshots inspected.
- Permanent regressions cover paginated discovery, numeric IDs, storage secrecy, existing selection, empty/errors/retry, auth/session/freshness, unchanged metadata authorization, missing bot token, SSRF, host-bound retained keys, stale UI responses, hostile names, and the selection limit.

Reproduce the permanent suite with `npm test`; targeted tests with `node --disable-warning=ExperimentalWarning --test tests/panelAuthorization.test.ts tests/panelGroups.test.ts`. Tests mock panel and Telegram requests; no production panel was used. No schema migration was added or executed for this UI update; migrations 0001–0024 are byte-identical to the verified starting archive.
